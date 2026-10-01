# DeadMansSwitch contracts

An on-chain dead man's switch for autonomous agents on Base. It holds ETH and up to 20 ERC-20
tokens. The agent (or the owner) pings it at least every `ttl` seconds. If the pings stop,
**anyone** can call `trigger()` after the deadline, and every asset moves to the beneficiary.

| Contract                | Role                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- |
| `DeadMansSwitchFactory` | Creates one isolated EIP-1167 clone per switch; the caller becomes the owner. |
| `DeadMansSwitch`        | The switch itself (implementation behind the clones; locked, not usable).     |

## Lifecycle

```
          ping() / setTtl()                 block.timestamp > deadline            trigger()
 Live  ─────────────────────▶  Live  ─────────────────────────────▶  Expired  ─────────────▶  Triggered
 owner: withdraw, setAgent,                                  nothing but trigger()          sweep(token)
 setBeneficiary, setTtl,                                     (no ping, no withdraw)         for leftovers
 add/removeToken
```

- `deadline() = lastPing + ttl`; `trigger()` works when `block.timestamp > deadline()`.
- **Expiry is final.** Once the deadline has passed, nothing revives the switch and the owner
  can no longer withdraw. The only way forward is `trigger()`, so the beneficiary can't be
  front-run.
- `setTtl` also counts as a ping, so shortening the TTL can never expire the switch on the spot.
- Funds only ever leave to the **owner** (`withdraw`, while live) or the **beneficiary**.
- `ttl` must be between 1 hour and 365 days.

## Robustness

- **Bounded:** at most 20 registered tokens. `trigger()` with 20 tokens stays well below
  1M gas (tested).
- **A broken token can't block the switch.** Token transfers in `trigger()` use `trySafeTransfer`,
  and balances are read with a guarded static call. A reverting or paused token emits
  `TransferFailed` and stays in the contract for `sweep()`. The same applies if the beneficiary
  rejects ETH.
- **A beneficiary that can't receive can still be paid.** If the beneficiary is a contract that
  rejects ETH, or an address a token blocklists (e.g. USDC/USDT), that transfer would otherwise
  leave the funds stuck — the beneficiary is fixed and, after the deadline, nobody can change it. So
  the **beneficiary** (and only the beneficiary) may call `setPayoutAddress(addr)` to redirect their
  payout to a reachable address; `trigger()` and `sweep()` then pay there. The owner can never
  redirect, so this adds no way to divert funds away from the beneficiary. `setBeneficiary` clears
  any redirect so a former beneficiary cannot capture a new one's funds.
- **Fee-on-transfer and rebasing tokens:** balances are never stored. `deposit` returns and logs
  what actually arrived (the balance difference), and `trigger`, `sweep` and full `withdraw`
  always move the live `balanceOf(this)`. A fee-on-transfer token delivers `balance − fee` to the
  recipient, and nothing is left behind. Tested with a 1 % fee token (plus fuzzed fees up to
  50 %) and a rebasing token.
- **Reentrancy:** `ReentrancyGuardTransient` on every function that moves value, plus
  checks-effects-interactions (`triggered` is set before any transfer). Tested with reentrant
  receivers.
- **Clones:** `initialize` runs in the same transaction as the clone's creation (in the factory),
  and the implementation contract locks itself in its constructor.
- Not upgradeable. OpenZeppelin Contracts v5.7.0, Solidity 0.8.30, EVM `cancun`.

## Usage

```solidity
address sw = factory.createSwitch{value: 1 ether}(agent, beneficiary, 1 days, tokens, salt);
factory.predictAddress(owner, salt);          // known before creation
IERC20(usdc).approve(sw, amount);
DeadMansSwitch(payable(sw)).deposit(usdc, amount);   // registered tokens; ETH can be sent directly
DeadMansSwitch(payable(sw)).ping();           // agent or owner, before deadline()
DeadMansSwitch(payable(sw)).status();         // (triggered, expired, deadline, lastPing, ttl)
DeadMansSwitch(payable(sw)).trigger();        // anyone, after the deadline
```

time2live's worker runs a **keeper** that discovers switches from `SwitchCreated` events and calls
`trigger()` on expired ones. It is only a convenience: triggering is permissionless, so the
beneficiary or anyone else can always trigger themselves.

### Trigger reward (optional, decentralises liveness)

`createSwitch(..., triggerRewardBps)` (0 by default, max 5%) pays whoever calls `trigger()` that
share of the switch's ETH balance; the rest goes to the beneficiary. A funded switch can therefore
attract third-party triggers (anyone, an MEV bot), so its liveness does not depend on time2live's
keeper being up. The reward is **best-effort**: if the caller rejects the ETH it simply flows to the
beneficiary, and it never blocks the trigger. ETH-only, computed as
`ethBalance * bps / 10000` — it does not touch ERC-20 transfers.

## Development

```sh
forge build
forge test                     # unit, fuzz (1,000 runs) and invariant tests
FOUNDRY_PROFILE=ci forge test  # 5,000 fuzz runs, deeper invariants (CI)
forge fmt --check
slither .                      # config: slither.config.json
```

Dependencies are git submodules (`git submodule update --init --recursive`).

Invariants (`test/DeadMansSwitch.invariant.t.sol`, random sequences of every action by the owner,
agent, a stranger and the beneficiary):

1. Funds only reach the owner or a beneficiary; all ETH is accounted for.
2. `trigger()` never succeeds at or before the deadline.
3. Expiry is final: no ping or `setTtl` revives an expired switch, and the owner receives nothing
   after expiry.
4. TTL bounds, `lastPing <= now` and the token cap always hold.

Slither excludes five detectors that are inherent to the design and reviewed:

- `timestamp`: a TTL contract has to compare against time, and ≥ 1 h TTLs make validator drift
  irrelevant.
- `low-level-calls`: ETH sends and the guarded `balanceOf`.
- `calls-loop`: the loop is bounded and failure-tolerant.
- `costly-loop`: a false positive; `pop()` runs once, then the loop breaks.
- `arbitrary-send-eth`: every ETH send goes to an intended party — the owner (`withdraw`), the
  beneficiary (`trigger`/`sweep`) or the trigger caller (the opt-in, bounded, best-effort reward).

## Deploy

```sh
cast wallet import deployer --interactive          # once; stores an encrypted keystore
forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast \
  --verify --etherscan-api-key "$ETHERSCAN_API_KEY"
```

**Take the factory address from the broadcast output, not from a script log line.** For a salted
deploy the address foundry computes in simulation does not reliably match the real on-chain address,
so the script deliberately prints only a simulation value. The authoritative address is the
`Contract Address:` line under `##### base-sepolia` in the broadcast output (also saved in
`broadcast/Deploy.s.sol/<chainid>/run-latest.json`). Set the keeper env from it (see
`docs/OPERATIONS.md`):

- `KEEPER_FACTORY_ADDRESS` = that `Contract Address`
- `KEEPER_FROM_BLOCK` = the `Block:` the deploy transaction landed in

Confirm it is the factory with `cast call <addr> "totalSwitches()(uint256)" --rpc-url base_sepolia`
(expect `0`). Record the address per chain — deploy once per chain and use the address the broadcast
reports.

### Verify on the block explorer

Publishing the source on Basescan matters: a switch holds funds, so people should be able to read
it before depositing. It is free. `--verify` on the deploy above does it in one step; to verify an
already-deployed contract, verify the **factory and the implementation** (the clones are EIP-1167
minimal proxies — Basescan then auto-detects them and links to the verified implementation, so
every switch becomes readable). You need an Etherscan API key (the v2 key works across chains,
Base included); `foundry.toml` supplies the compiler settings.

```sh
export ETHERSCAN_API_KEY=…
IMPL=$(cast call <factory> "implementation()(address)" --rpc-url base_sepolia)
forge verify-contract <factory> src/DeadMansSwitchFactory.sol:DeadMansSwitchFactory --chain 84532 --watch
forge verify-contract "$IMPL"  src/DeadMansSwitch.sol:DeadMansSwitch               --chain 84532 --watch
```

Neither contract takes constructor arguments. If `--watch` times out with `Pending in queue`, the
submission still succeeded — check with `forge verify-check <GUID> --chain 84532` or just open the
address on the explorer a minute later. For mainnet use `--chain 8453`.
