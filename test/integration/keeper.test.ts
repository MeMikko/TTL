import { eq } from 'drizzle-orm';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  http,
  parseEther,
  toFunctionSelector,
  toEventSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../../src/core/db/index.js';
import { createKeeper, factoryAbi, switchAbi } from '../../src/worker/keeper.js';
import { silentLogger, testDatabase } from '../helpers/app.js';
import { ANVIL_KEYS, contractArtifact, foundryBin, startAnvil } from '../helpers/anvil.js';
import { resetDb } from '../helpers/auth.js';

// Foundry is required in CI; locally the suite is skipped (with a notice) if it is missing.
const hasFoundry = Boolean(foundryBin('anvil') && foundryBin('forge'));
if (!hasFoundry && process.env.CI) throw new Error('Foundry (anvil, forge) is required in CI');
if (!hasFoundry) console.warn('keeper tests skipped: install Foundry to run them');

const database = testDatabase();
const db = database.db;

describe.skipIf(!hasFoundry)('keeper (anvil)', () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let factoryArtifact: ReturnType<typeof contractArtifact>;
  let switchArtifact: ReturnType<typeof contractArtifact>;
  let tokenArtifacts: Record<'MockToken' | 'GasBombToken', ReturnType<typeof contractArtifact>>;
  let factory: Address;
  let deployBlock: bigint;

  const deployer = privateKeyToAccount(ANVIL_KEYS[0]);
  const owner = privateKeyToAccount(ANVIL_KEYS[2]);
  const agent = privateKeyToAccount(ANVIL_KEYS[3]);
  const beneficiary = '0x000000000000000000000000000000000000bEEF' as Address;

  let pub: ReturnType<typeof createPublicClient>;
  let test: ReturnType<typeof createTestClient>;
  const walletOf = (account: typeof owner) =>
    createWalletClient({ chain: foundry, transport: http(anvil.rpcUrl), account });

  beforeAll(async () => {
    anvil = await startAnvil();
    factoryArtifact = contractArtifact('DeadMansSwitchFactory.sol', 'DeadMansSwitchFactory');
    switchArtifact = contractArtifact('DeadMansSwitch.sol', 'DeadMansSwitch');
    tokenArtifacts = {
      MockToken: contractArtifact('Tokens.sol', 'MockToken'),
      GasBombToken: contractArtifact('Tokens.sol', 'GasBombToken'),
    };
    pub = createPublicClient({ chain: foundry, transport: http(anvil.rpcUrl) });
    test = createTestClient({ chain: foundry, mode: 'anvil', transport: http(anvil.rpcUrl) });
  }, 120_000);

  afterAll(async () => {
    await anvil?.stop();
    await database.close();
  });

  beforeEach(async () => {
    await resetDb(database);
    await database.pool.query('TRUNCATE keeper_cursors, keeper_switches');
    // A fresh factory per test: the chain keeps state between tests, the database does not.
    const hash = await walletOf(deployer).deployContract({
      abi: factoryArtifact.abi,
      bytecode: factoryArtifact.bytecode,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    factory = receipt.contractAddress!;
    deployBlock = receipt.blockNumber;
  });

  function keeper(overrides: Partial<Parameters<typeof createKeeper>[0]> = {}) {
    return createKeeper({
      db,
      logger: silentLogger,
      rpcUrl: anvil.rpcUrl,
      chainId: 31337,
      factory,
      privateKey: ANVIL_KEYS[1],
      fromBlock: Number(deployBlock),
      logChunk: 3,
      confirmations: 0,
      maxFeeGwei: 100,
      maxGas: 1_500_000,
      minBalanceEth: 0.01,
      ...overrides,
    });
  }

  let saltCounter = 0;
  async function createSwitch(
    ttlSeconds = 3600,
    ethWei = parseEther('1'),
    tokens: readonly Address[] = [],
  ) {
    const salt = `0x${(++saltCounter).toString(16).padStart(64, '0')}` as Hex;
    const { request, result } = await pub.simulateContract({
      account: owner,
      address: factory,
      abi: factoryArtifact.abi,
      functionName: 'createSwitch',
      args: [agent.address, beneficiary, BigInt(ttlSeconds), tokens, salt],
      value: ethWei,
    });
    await pub.waitForTransactionReceipt({ hash: await walletOf(owner).writeContract(request) });
    return result as Address;
  }

  const status = (address: Address) =>
    pub.readContract({ address, abi: switchAbi, functionName: 'status' });

  /** Deploys a mock token (see contracts/test/mocks/Tokens.sol) and mints `mintTo` 1e18 of it. */
  async function deployToken(name: 'MockToken' | 'GasBombToken', mintTo?: Address) {
    const hash = await walletOf(deployer).deployContract({
      abi: tokenArtifacts[name].abi,
      bytecode: tokenArtifacts[name].bytecode,
    });
    const token = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    if (mintTo) {
      const { request } = await pub.simulateContract({
        account: deployer,
        address: token,
        abi: tokenArtifacts[name].abi,
        functionName: 'mint',
        args: [mintTo, parseEther('1')],
      });
      await pub.waitForTransactionReceipt({
        hash: await walletOf(deployer).writeContract(request),
      });
    }
    return token;
  }

  async function fundEth(to: Address, value: bigint) {
    await pub.waitForTransactionReceipt({
      hash: await walletOf(deployer).sendTransaction({ to, value }),
    });
  }

  /** Makes the keeper treat every switch as due for its slow refresh. */
  const expireRefresh = () =>
    database.pool.query(`UPDATE keeper_switches SET checked_at = now() - interval '1 hour'`);

  const rowOf = async (address: Address) =>
    (
      await db
        .select()
        .from(schema.keeperSwitches)
        .where(eq(schema.keeperSwitches.address, address.toLowerCase()))
    )[0]!;

  async function advance(seconds: number) {
    await test.increaseTime({ seconds });
    await test.mine({ blocks: 1 });
  }

  it("the keeper's ABI matches the compiled contracts", () => {
    const has = (abi: Abi, item: AbiFunction | AbiEvent) =>
      abi.some(
        (x) =>
          x.type === item.type &&
          (item.type === 'event'
            ? toEventSelector(x as AbiEvent) === toEventSelector(item)
            : toFunctionSelector(x as AbiFunction) === toFunctionSelector(item)),
      );
    expect(has(factoryArtifact.abi, factoryAbi[0])).toBe(true);
    for (const item of switchAbi) {
      if (item.type === 'function') expect(has(switchArtifact.abi, item), item.name).toBe(true);
    }
  });

  it('discovers switches, leaves live ones alone and triggers expired ones', async () => {
    const live = await createSwitch(7200);
    const dying = await createSwitch(3600);
    const k = keeper();

    let r = await k.pass();
    expect(r).toMatchObject({ discovered: 2, triggered: 0 });
    const rows = await db.select().from(schema.keeperSwitches);
    expect(rows.map((x) => x.address).sort()).toEqual(
      [live, dying].map((a) => a.toLowerCase()).sort(),
    );
    expect(rows.every((x) => x.deadline !== null && x.checkedAt !== null)).toBe(true);

    // Only the 1 h switch expires; the agent of the 2 h one keeps pinging.
    await advance(3601);
    r = await k.pass();
    expect(r).toMatchObject({ discovered: 0, triggered: 1, failed: 0 });
    expect((await status(dying))[0]).toBe(true);
    expect((await status(live))[0]).toBe(false);
    const before = await pub.getBalance({ address: beneficiary });
    expect(before).toBeGreaterThanOrEqual(parseEther('1'));

    const [row] = await db
      .select()
      .from(schema.keeperSwitches)
      .where(eq(schema.keeperSwitches.address, dying.toLowerCase()));
    expect(row!.triggeredAt).not.toBeNull();
    expect(row!.triggerTx).toMatch(/^0x[0-9a-f]{64}$/);

    // Nothing left to do: triggered switches are not checked again.
    r = await k.pass();
    expect(r).toMatchObject({ triggered: 0, failed: 0 });
  });

  it('resumes scanning from its cursor and records switches triggered by someone else', async () => {
    const k = keeper();
    await k.pass();
    const s = await createSwitch(3600, 0n);
    await advance(3601);
    // Someone else (e.g. the beneficiary) triggers first.
    const { request } = await pub.simulateContract({
      account: agent,
      address: s,
      abi: switchAbi,
      functionName: 'trigger',
    });
    await pub.waitForTransactionReceipt({ hash: await walletOf(agent).writeContract(request) });

    const r = await k.pass();
    expect(r).toMatchObject({ discovered: 1, triggered: 0, failed: 0 });
    const [row] = await db.select().from(schema.keeperSwitches);
    expect(row).toMatchObject({ triggerTx: null });
    expect(row!.triggeredAt).not.toBeNull();
  });

  it('does not send when gas is above the fee cap', async () => {
    const s = await createSwitch(3600);
    await advance(3601);
    const r = await keeper({ maxFeeGwei: 0.000001 }).pass();
    expect(r).toMatchObject({ triggered: 0, failed: 1 });
    expect((await status(s))[0]).toBe(false);
    const [row] = await db.select().from(schema.keeperSwitches);
    expect(row!.lastError).toMatch(/KEEPER_MAX_FEE_GWEI/);
  });

  it('skips empty switches, and triggers them once assets arrive', async () => {
    const empty = await createSwitch(3600, 0n);
    const k = keeper();
    await k.pass();
    await advance(3601);

    let r = await k.pass();
    expect(r).toMatchObject({ triggered: 0, skipped: 1, failed: 0 });
    expect((await status(empty))[0]).toBe(false);
    const row = await rowOf(empty);
    expect(row.skippedAt).not.toBeNull();
    expect(row.lastError).toMatch(/nothing to transfer/);

    // A skipped switch is not re-read every pass...
    r = await k.pass();
    expect(r).toMatchObject({ checked: 0, skipped: 0 });

    // ...only on the slow refresh, which triggers it if something was deposited meanwhile.
    await fundEth(empty, parseEther('0.5'));
    await expireRefresh();
    r = await k.pass();
    expect(r).toMatchObject({ triggered: 1, skipped: 0, failed: 0 });
    expect((await status(empty))[0]).toBe(true);
  });

  it('triggers a switch that holds only tokens', async () => {
    const token = await deployToken('MockToken');
    const s = await createSwitch(3600, 0n, [token]);
    const { request } = await pub.simulateContract({
      account: deployer,
      address: token,
      abi: tokenArtifacts.MockToken.abi,
      functionName: 'mint',
      args: [s, 123n],
    });
    await pub.waitForTransactionReceipt({ hash: await walletOf(deployer).writeContract(request) });
    await advance(3601);

    const r = await keeper().pass();
    expect(r).toMatchObject({ triggered: 1, skipped: 0, failed: 0 });
    expect(
      await pub.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [beneficiary],
      }),
    ).toBe(123n);
  });

  it('triggers a full 20-token switch within the default gas cap', async () => {
    const tokens: Address[] = [];
    for (let i = 0; i < 20; i++) tokens.push(await deployToken('MockToken'));
    const s = await createSwitch(3600, parseEther('1'), tokens);
    for (const token of tokens) {
      const { request } = await pub.simulateContract({
        account: deployer,
        address: token,
        abi: tokenArtifacts.MockToken.abi,
        functionName: 'mint',
        args: [s, 1n],
      });
      await pub.waitForTransactionReceipt({
        hash: await walletOf(deployer).writeContract(request),
      });
    }
    await advance(3601);

    const r = await keeper().pass();
    expect(r).toMatchObject({ triggered: 1, failed: 0 });
    expect((await status(s))[0]).toBe(true);
    const receipt = await pub.getTransactionReceipt({
      hash: (await rowOf(s)).triggerTx as Hex,
    });
    expect(receipt.gasUsed).toBeLessThan(1_500_000n);
  }, 60_000);

  it('skips a switch whose token burns all gas, and caps the gas limit it sends', async () => {
    // The bomb's transfer eats 63/64 of the gas it gets, so trigger() only succeeds with ~64×
    // the gas still needed after it: registering real tokens behind the bomb inflates the cost.
    const bomb = await deployToken('GasBombToken');
    const tail: Address[] = [];
    for (let i = 0; i < 5; i++) tail.push(await deployToken('MockToken'));
    const s = await createSwitch(3600, parseEther('1'), [bomb, ...tail]);
    for (const [token, name] of [
      [bomb, 'GasBombToken'],
      ...tail.map((t) => [t, 'MockToken'] as const),
    ] as const) {
      const { request } = await pub.simulateContract({
        account: deployer,
        address: token,
        abi: tokenArtifacts[name].abi,
        functionName: 'mint',
        args: [s, 1n],
      });
      await pub.waitForTransactionReceipt({
        hash: await walletOf(deployer).writeContract(request),
      });
    }
    await advance(3601);

    const keeperAddress = privateKeyToAccount(ANVIL_KEYS[1]).address;
    const before = await pub.getBalance({ address: keeperAddress });
    const r = await keeper().pass();
    expect(r).toMatchObject({ triggered: 0, skipped: 1, failed: 0 });
    expect((await status(s))[0]).toBe(false);
    expect((await rowOf(s)).lastError).toMatch(/KEEPER_MAX_GAS/);
    expect(await pub.getBalance({ address: keeperAddress })).toBe(before); // nothing was sent

    // With a higher cap it does go through, and the keeper pays for at most that cap.
    await expireRefresh();
    const r2 = await keeper({ maxGas: 30_000_000 }).pass();
    expect(r2).toMatchObject({ triggered: 1 });
    const tx = await pub.getTransaction({ hash: (await rowOf(s)).triggerTx as Hex });
    expect(tx.gas).toBeLessThanOrEqual(30_000_000n);
  }, 60_000);

  it('handles real expiries before re-checking skipped switches', async () => {
    const empty = await createSwitch(3600, 0n);
    const k = keeper({ checkBatch: 1 });
    await k.pass();
    await advance(3601);
    expect(await k.pass()).toMatchObject({ skipped: 1 });

    const funded = await createSwitch(3600);
    await k.pass(); // discovers and reads it (live)
    await advance(3601);
    // The skipped switch has the older deadline and is due for refresh, but with room for only
    // one switch per pass the funded expiry goes first.
    await expireRefresh();
    const r = await k.pass();
    expect(r).toMatchObject({ checked: 1, triggered: 1 });
    expect((await status(funded))[0]).toBe(true);
    expect((await status(empty))[0]).toBe(false);
  });

  it('handles fresh expiries before retrying failed ones', async () => {
    const failing = await createSwitch(3600);
    const fresh = await createSwitch(5400);
    await keeper().pass();
    await advance(3601);
    expect(await keeper({ maxFeeGwei: 0.000001 }).pass()).toMatchObject({ failed: 1 });
    await advance(1800);

    // Both are expired and the failing one has the older deadline, but the fresh one goes first.
    const r = await keeper({ checkBatch: 1 }).pass();
    expect(r).toMatchObject({ checked: 1, triggered: 1 });
    expect((await status(fresh))[0]).toBe(true);
    expect((await status(failing))[0]).toBe(false);
  });

  it('refuses an RPC for the wrong chain', async () => {
    await expect(keeper({ chainId: 84532 }).pass()).rejects.toThrow(/serves chain 31337/);
  });
});
