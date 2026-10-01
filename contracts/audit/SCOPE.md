# DeadMansSwitch — audit handoff

A self-contained package for an external security review. Everything an auditor needs to build, test,
and reason about the contracts is here or linked from here.

## 1. Overview

`DeadMansSwitch` is a non-custodial, on-chain dead man's switch for autonomous agents on Base. Each
switch holds ETH and up to 20 ERC-20 tokens. The agent (or owner) must `ping()` at least every `ttl`
seconds; if pings stop, **anyone** may call `trigger()` after the deadline and every asset moves to a
fixed `beneficiary`. There is no admin, no upgradeability, and no privileged keeper — triggering is
permissionless. A convenience keeper (off-chain) only calls the same public `trigger()`.

| Contract                | Role                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DeadMansSwitchFactory` | Deploys one isolated EIP-1167 clone per switch (caller = owner); keepers discover switches via `SwitchCreated`. Deterministic address per `(owner, salt)`. |
| `DeadMansSwitch`        | The switch itself; implementation behind the clones (locked in its constructor).                                                                           |

## 2. Scope

|                  |                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| **Commit**       | `f5f5682edaee6e8178b859fb459addc2664bdcad` (branch `main`)                                            |
| **In scope**     | `contracts/src/DeadMansSwitch.sol` (440 LOC), `contracts/src/DeadMansSwitchFactory.sol` (93 LOC)      |
| **Script**       | `contracts/script/Deploy.s.sol` (deployment only, review for correctness, not security-critical)      |
| **Out of scope** | Off-chain keeper (`src/worker/keeper.ts`), the API/MCP service, test mocks, OpenZeppelin library code |
| **SLOC**         | ~533 source lines, 2 files, no external calls except token transfers and ETH sends                    |

## 3. Build & test

Dependencies are git submodules (OpenZeppelin Contracts **v5.7.0**, forge-std). Foundry required.

```sh
git submodule update --init --recursive
cd contracts
forge build                      # Solc 0.8.30, EVM cancun, optimizer 10_000 runs
forge test                       # unit + fuzz (1,000 runs) + invariants (256×64)
FOUNDRY_PROFILE=ci forge test    # fuzz 5,000 runs, invariants 512×128 (what CI runs)
forge fmt --check
slither .                        # config: contracts/slither.config.json
```

Current status: **51 tests pass** (unit, fuzz, 4 invariants). Compiler settings are pinned in
`contracts/foundry.toml`.

## 4. Architecture & lifecycle

```
          ping() / setTtl()                 block.timestamp > deadline            trigger()
 Live  ─────────────────────▶  Live  ─────────────────────────────▶  Expired  ─────────────▶  Triggered
 owner: withdraw, setAgent,                                  nothing but trigger()          sweep(token)
 setBeneficiary, setTtl,                                     (no ping, no withdraw)         for leftovers
 add/removeToken, proposeCancel
```

- `deadline() = lastPing + ttl`; `trigger()` requires `block.timestamp > deadline()`.
- **Expiry is final:** once past the deadline the owner can no longer withdraw or revive the switch;
  only `trigger()` works, so the beneficiary cannot be front-run.
- `ttl` ∈ [1 hour, 365 days]. At most 20 registered tokens (bounds the `trigger()` loop).
- Mutual cancellation: the owner `proposeCancel()`, the beneficiary `approveCancel()` → all funds
  return to the owner (terminal, `cancelled = true`).

## 5. Roles & trust model

| Action                                                                                                         | Who            | When                                                  |
| -------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------- |
| `ping`                                                                                                         | agent or owner | while live                                            |
| `withdraw`, `setAgent`, `setBeneficiary`, `setTtl`, `addToken`, `removeToken`, `proposeCancel`, `revokeCancel` | owner          | while live                                            |
| `approveCancel`, `setPayoutAddress`                                                                            | beneficiary    | approveCancel: while live; setPayoutAddress: any time |
| `deposit`, send ETH                                                                                            | anyone         | before trigger (ETH any time)                         |
| `trigger`                                                                                                      | **anyone**     | after deadline                                        |
| `sweep`                                                                                                        | **anyone**     | after termination                                     |

**Funds can only ever leave to:** the owner (`withdraw` / `approveCancel`), the beneficiary or its
beneficiary-set redirect (`trigger` / `sweep`), or the trigger caller (an opt-in reward, ≤ 5% of the
ETH balance, set by the owner at creation). The owner can never redirect the beneficiary's payout.

## 6. Invariants (tested — `test/DeadMansSwitch.invariant.t.sol`)

Random sequences of every action by owner, agent, a stranger and the beneficiary must preserve:

1. Funds only ever reach the owner or the beneficiary; all ETH is accounted for.
2. `trigger()` never succeeds at or before the deadline.
3. Expiry is final: no `ping`/`setTtl` revives an expired switch, and the owner receives nothing
   after expiry.
4. TTL bounds, `lastPing <= now`, and the token cap always hold.

## 7. Internal review — findings and resolutions

A thorough internal review (not a substitute for this engagement) found and resolved:

| ID  | Severity | Finding                                                                                                                                                            | Resolution                                                                                                                              |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| H   | High     | A permanently-rejecting beneficiary (ETH-rejecting contract, or token-blocklisted address) with an immutable beneficiary → funds stuck forever                     | **Fixed:** `setPayoutAddress` lets only the beneficiary redirect its payout; `trigger`/`sweep` pay the redirect. Owner cannot redirect. |
| M1  | Medium   | After `approveCancel` (funds → owner), `sweep` still sent to the beneficiary, so ETH that failed to reach an ETH-rejecting owner could be swept to the beneficiary | **Fixed:** `cancelled` flag routes `sweep` to the owner after a cancel, to the beneficiary after a trigger                              |
| L1  | Low      | A gas-burning token can stall `trigger()`                                                                                                                          | **Documented** (owner-selected tokens; no per-token gas cap, which would break legitimate heavy tokens; keeper bounds total gas)        |
| L5  | Info     | `Triggered` logged the effective recipient, not the literal beneficiary                                                                                            | **Fixed:** logs the beneficiary                                                                                                         |

**Left as deliberate design choices (please confirm or challenge):**

- **No owner key rotation / ownership transfer.** A lost owner key means the owner can no longer
  `withdraw`; the beneficiary path still functions. Intentional (minimal attack surface).
- **A compromised agent key** can keep `ping`-ing to delay `trigger()`. Mitigated: the owner can
  `setAgent`, `withdraw`, or `proposeCancel` while live.
- **`getAllSwitches` / `getSwitchesByOwner`** return unbounded arrays and the factory is open to
  spam (anyone may `createSwitch`). On-chain callers can OOG; keepers use `SwitchCreated` events.
- **Timestamp dependence** is inherent; `ttl ≥ 1h` makes validator drift irrelevant.

## 8. Areas we would most like scrutinised

1. The **payout-redirect** mechanism (`setPayoutAddress` / `_payoutTo`) and its interaction with
   `setBeneficiary` (which clears the redirect), `trigger`, and `sweep` — any way for the owner to
   divert the beneficiary's funds, or for a former beneficiary to capture a new one's funds?
2. **`sweep` routing** after trigger vs. cancel (`cancelled` flag) — any state where leftovers reach
   the wrong party?
3. The **trigger reward** path: reentrancy, rounding, and the best-effort ETH sends
   (`trigger`/`approveCancel` never revert on a failed transfer; `receive()` is not guarded).
4. **Clone initialization**: the factory creates and `initialize`s in one transaction; the
   implementation locks itself. Any front-running or re-initialization vector?
5. **Fee-on-transfer / rebasing / broken tokens**: balance-diff accounting, `trySafeTransfer`, and
   the guarded `_balanceOf` static call.
6. **ReentrancyGuardTransient** (EIP-1153) correctness across clones.

## 9. Deployment

- The factory is deployed through the canonical CREATE2 deployer with a fixed salt, so its address is
  deterministic across chains (Base Sepolia `84532`, Base mainnet `8453`). The implementation is
  deployed by the factory's constructor.
- **Note:** a testnet factory from an earlier bytecode is live at
  `0x3D7cE7C30b712bC070Ba1ea2918Bd2211AD4349A` (Base Sepolia), verified on Basescan + Sourcify. It
  predates the H/M1/L fixes above — **the audit target is the source at the commit in §2**, which
  will be redeployed to a new address after this review. Do not audit the deployed testnet bytecode.
- Deploy script: `contracts/script/Deploy.s.sol`. Operational detail in `docs/OPERATIONS.md`.

## 10. Slither

`contracts/slither.config.json` fails on low+ and excludes five detectors that are inherent to the
design and reviewed: `timestamp`, `low-level-calls`, `calls-loop`, `costly-loop`,
`arbitrary-send-eth` (every ETH send goes to owner / beneficiary / redirect / opt-in reward caller).
Rationale is documented in `contracts/README.md`.

## 11. Logistics (fill in before sending)

- **Primary contact:** `<name / email>`
- **Preferred report format / disclosure window:** `<…>`
- **Fix-review round included?** `<yes/no>`
- **Post-audit bug bounty** (Immunefi / Hats) planned: `<yes/no>`
