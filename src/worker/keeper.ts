import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  formatEther,
  formatGwei,
  getAddress,
  http,
  parseAbi,
  parseEther,
  parseGwei,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, foundry } from 'viem/chains';
import type { Db } from '../core/db/index.js';
import { schema } from '../core/db/index.js';
import type { Logger } from '../core/logger.js';

/** The subset of the contracts' ABI the keeper uses (checked against the build in tests). */
export const factoryAbi = parseAbi([
  'event SwitchCreated(address indexed switchAddress, address indexed owner, address indexed agent, address beneficiary, uint64 ttl)',
]);
export const switchAbi = parseAbi([
  'function status() view returns (bool triggered, bool expired, uint64 deadline, uint64 lastPing, uint64 ttl)',
  'function trigger()',
  'error NotExpired()',
  'error AlreadyTriggered()',
]);

const CHAINS = { 84532: baseSepolia, 8453: base, 31337: foundry } as const;

/**
 * A deadline can move *earlier* only through setTtl, which also counts as a ping, so it is never
 * closer than now + MIN_TTL (1 h). Re-reading every switch at least this often therefore never
 * misses an expiry by more than this interval.
 */
const REFRESH_MS = 30 * 60_000;
const CHECK_BATCH = 200;
const MAX_CHUNKS_PER_PASS = 50;
const LOW_BALANCE_WARN_EVERY_MS = 60 * 60_000;

export interface KeeperOptions {
  db: Db;
  logger: Logger;
  rpcUrl: string;
  chainId: keyof typeof CHAINS;
  factory: string;
  privateKey: Hex;
  fromBlock: number;
  logChunk: number;
  confirmations: number;
  maxFeeGwei: number;
  minBalanceEth: number;
}

export interface KeeperPassResult {
  discovered: number;
  checked: number;
  triggered: number;
  failed: number;
}

export type Keeper = ReturnType<typeof createKeeper>;

/**
 * Watches every DeadMansSwitch created by the factory and calls `trigger()` on the expired ones.
 * Triggering is permissionless, so the keeper is a convenience: if it is down, anyone (the
 * beneficiary included) can still trigger.
 */
export function createKeeper(opts: KeeperOptions) {
  const { db, logger, chainId } = opts;
  const chain = CHAINS[chainId];
  const transport = http(opts.rpcUrl, { batch: true, timeout: 20_000, retryCount: 2 });
  const client = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(opts.privateKey);
  const wallet = createWalletClient({ chain, transport, account });
  const factory = getAddress(opts.factory);
  const factoryKey = factory.toLowerCase();
  const maxFee = parseGwei(String(opts.maxFeeGwei));
  const minBalance = parseEther(String(opts.minBalanceEth));
  let chainVerified = false;
  let lastLowBalanceWarn = 0;

  async function verifyChain() {
    const actual = await client.getChainId();
    if (actual !== chainId) {
      throw new Error(`KEEPER_RPC_URL serves chain ${actual}, expected ${chainId}`);
    }
    chainVerified = true;
    logger.info({ chainId, factory, keeper: account.address }, 'keeper started');
  }

  /** Scans new SwitchCreated logs (confirmed blocks only) and records the switches. */
  async function discover(): Promise<number> {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const safe = head - BigInt(opts.confirmations);
    const [cursor] = await db
      .select({ nextBlock: schema.keeperCursors.nextBlock })
      .from(schema.keeperCursors)
      .where(
        and(
          eq(schema.keeperCursors.chainId, chainId),
          eq(schema.keeperCursors.factory, factoryKey),
        ),
      );
    let from = BigInt(cursor?.nextBlock ?? opts.fromBlock);
    let found = 0;
    for (let i = 0; i < MAX_CHUNKS_PER_PASS && from <= safe; i++) {
      const to =
        from + BigInt(opts.logChunk) - 1n < safe ? from + BigInt(opts.logChunk) - 1n : safe;
      const logs = await client.getLogs({
        address: factory,
        event: factoryAbi[0],
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      await db.transaction(async (tx) => {
        if (logs.length) {
          await tx
            .insert(schema.keeperSwitches)
            .values(
              logs.map((l) => ({
                chainId,
                address: l.args.switchAddress.toLowerCase(),
                owner: l.args.owner.toLowerCase(),
                createdBlock: Number(l.blockNumber),
              })),
            )
            .onConflictDoNothing();
        }
        await tx
          .insert(schema.keeperCursors)
          .values({ chainId, factory: factoryKey, nextBlock: Number(to + 1n) })
          .onConflictDoUpdate({
            target: [schema.keeperCursors.chainId, schema.keeperCursors.factory],
            set: { nextBlock: Number(to + 1n), updatedAt: sql`now()` },
          });
      });
      found += logs.length;
      from = to + 1n;
    }
    if (found) logger.info({ found }, 'keeper discovered switches');
    return found;
  }

  function revertName(err: unknown): string | undefined {
    if (!(err instanceof BaseError)) return undefined;
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    return revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
  }

  const shortError = (err: unknown) =>
    ((err instanceof BaseError ? err.shortMessage : (err as Error)?.message) ?? String(err)).slice(
      0,
      500,
    );

  async function markTriggered(address: string, txHash: string | null) {
    await db
      .update(schema.keeperSwitches)
      .set({ triggeredAt: new Date(), triggerTx: txHash, lastError: null })
      .where(
        and(eq(schema.keeperSwitches.chainId, chainId), eq(schema.keeperSwitches.address, address)),
      );
  }

  async function recordError(address: string, message: string) {
    await db
      .update(schema.keeperSwitches)
      .set({ lastError: message })
      .where(
        and(eq(schema.keeperSwitches.chainId, chainId), eq(schema.keeperSwitches.address, address)),
      );
  }

  /** Sends trigger() after simulating it. Returns true when the switch is now triggered. */
  async function trigger(address: string): Promise<boolean> {
    const fees = await client.estimateFeesPerGas();
    if (fees.maxFeePerGas > maxFee) {
      const msg = `max fee ${formatGwei(fees.maxFeePerGas)} gwei above KEEPER_MAX_FEE_GWEI`;
      logger.warn({ address }, msg);
      await recordError(address, msg);
      return false;
    }
    try {
      const { request } = await client.simulateContract({
        account,
        address: address as Address,
        abi: switchAbi,
        functionName: 'trigger',
      });
      const hash = await wallet.writeContract(request);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') {
        await recordError(address, `trigger transaction reverted: ${hash}`);
        return false;
      }
      await markTriggered(address, hash);
      logger.info({ address, tx: hash }, 'keeper triggered switch');
      return true;
    } catch (err) {
      if (revertName(err) === 'AlreadyTriggered') {
        await markTriggered(address, null); // someone else was first
        return true;
      }
      logger.warn({ address, err: shortError(err) }, 'keeper trigger failed');
      await recordError(address, shortError(err));
      return false;
    }
  }

  /** Reads due / stale switches and triggers the expired ones. */
  async function check(): Promise<Omit<KeeperPassResult, 'discovered'>> {
    const block = await client.getBlock();
    const chainNow = Number(block.timestamp);
    const t = schema.keeperSwitches;
    const rows = await db
      .select({ address: t.address })
      .from(t)
      .where(
        and(
          eq(t.chainId, chainId),
          isNull(t.triggeredAt),
          or(
            isNull(t.deadline),
            lt(t.deadline, chainNow),
            isNull(t.checkedAt),
            lt(t.checkedAt, new Date(Date.now() - REFRESH_MS)),
          ),
        ),
      )
      .orderBy(asc(t.deadline))
      .limit(CHECK_BATCH);

    const statuses = await Promise.all(
      rows.map(async ({ address }) => {
        try {
          const [triggered, expired, deadline] = await client.readContract({
            address: address as Address,
            abi: switchAbi,
            functionName: 'status',
          });
          return { ok: true as const, address, triggered, expired, deadline: Number(deadline) };
        } catch (err) {
          return { ok: false as const, address, error: shortError(err) };
        }
      }),
    );

    let triggered = 0;
    let failed = 0;
    for (const s of statuses) {
      if (!s.ok) {
        failed++;
        await recordError(s.address, s.error);
        continue;
      }
      await db
        .update(t)
        .set({
          deadline: s.deadline,
          checkedAt: new Date(),
          ...(s.triggered ? { triggeredAt: new Date() } : {}),
        })
        .where(and(eq(t.chainId, chainId), eq(t.address, s.address)));
      // Sequential on purpose: one nonce stream from one hot wallet.
      if (s.expired && !s.triggered) {
        if (await trigger(s.address)) triggered++;
        else failed++;
      }
    }
    return { checked: rows.length, triggered, failed };
  }

  async function checkBalance() {
    const balance = await client.getBalance({ address: account.address });
    if (balance < minBalance && Date.now() - lastLowBalanceWarn > LOW_BALANCE_WARN_EVERY_MS) {
      lastLowBalanceWarn = Date.now();
      logger.warn(
        { keeper: account.address, balanceEth: formatEther(balance) },
        'keeper balance low: top up the hot wallet',
      );
    }
    return balance;
  }

  return {
    address: account.address,
    async pass(): Promise<KeeperPassResult> {
      if (!chainVerified) await verifyChain();
      const discovered = await discover();
      const result = await check();
      await checkBalance();
      return { discovered, ...result };
    },
  };
}
