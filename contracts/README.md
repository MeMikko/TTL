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

Slither excludes four detectors that are inherent to the design and reviewed:

- `timestamp`: a TTL contract has to compare against time, and ≥ 1 h TTLs make validator drift
  irrelevant.
- `low-level-calls`: ETH sends and the guarded `balanceOf`.
- `calls-loop`: the loop is bounded and failure-tolerant.
- `costly-loop`: a false positive; `pop()` runs once, then the loop breaks.

## Deploy

The factory goes through the deterministic CREATE2 deployer, so its address is the same on
every chain.

```sh
cast wallet import deployer --interactive          # once; stores an encrypted keystore
forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast \
  --verify --etherscan-api-key "$ETHERSCAN_API_KEY"
```

The script prints `KEEPER_FACTORY_ADDRESS` (the real deterministic CREATE2 address — under
`--broadcast` this differs from the address shown in simulation, so trust this printed line) and
`KEEPER_FROM_BLOCK`. Set both for the keeper (see `docs/OPERATIONS.md`), and verify the address
with `cast call <addr> "totalSwitches()(uint256)" --rpc-url base_sepolia` (expect `0`).
