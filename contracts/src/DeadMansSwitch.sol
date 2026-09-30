// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title DeadMansSwitch
/// @notice Holds ETH and ERC-20 tokens for an autonomous agent. The agent (or the owner) must
/// `ping()` at least once every `ttl` seconds. If it stops, anyone may call `trigger()` after the
/// deadline and every asset moves to the `beneficiary`.
///
/// Lifecycle:
///  - **Live** (`block.timestamp <= deadline()`): the owner manages settings and may withdraw;
///    the agent or owner pings to push the deadline forward.
///  - **Expired** (`block.timestamp > deadline()`, not yet triggered): the switch is committed.
///    Nothing can revive it or move funds anywhere but to the beneficiary; only `trigger()` works.
///  - **Triggered** (terminal): assets were sent to the beneficiary; `sweep()` forwards leftovers
///    (late deposits, tokens that failed or were not registered).
///
/// Funds can only ever leave to the owner (`withdraw`, while live; or `approveCancel` upon mutual
/// agreement) or the beneficiary (`trigger` / `sweep`).
///
/// @dev Deployed as EIP-1167 clones by `DeadMansSwitchFactory`; `initialize` runs once in the
/// clone's creation transaction. Not upgradeable.
///
/// Fee-on-transfer and rebasing tokens: the contract never stores token balances. Deposits
/// report the amount actually received (balance difference), and `trigger`, `sweep` and
/// `withdraw` of the full amount always use the live `balanceOf(this)`. A fee-on-transfer token
/// therefore delivers `balance - fee` to the recipient; nothing is ever left locked by
/// accounting drift.
contract DeadMansSwitch is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Bounds for `ttl`.
    uint64 public constant MIN_TTL = 1 hours;
    uint64 public constant MAX_TTL = 365 days;
    /// @notice Registered token cap; keeps the loop in `trigger()` bounded.
    uint256 public constant MAX_TOKENS = 20;

    address public owner;
    address public agent;
    address public beneficiary;
    uint64 public ttl;
    uint64 public lastPing;
    bool public triggered;
    bool public cancelProposed;
    bool private _initialized;

    string public reason;

    address[] private _tokens;
    mapping(address token => bool) public isToken;

    event Initialized(address indexed owner, address indexed agent, address indexed beneficiary, uint64 ttl);
    event Pinged(address indexed by, uint64 deadline);
    event Deposited(address indexed from, address indexed token, uint256 received);
    event Withdrawn(address indexed token, uint256 amount);
    event AgentChanged(address indexed agent);
    event BeneficiaryChanged(address indexed beneficiary);
    event TtlChanged(uint64 ttl);
    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);
    event CancelProposed();
    event CancelProposalRevoked();
    event Cancelled(address indexed by);
    event Triggered(address indexed by, address indexed beneficiary);
    event Transferred(address indexed token, address indexed to, uint256 amount);
    event TransferFailed(address indexed token, uint256 amount);
    event Swept(address indexed token, uint256 amount);

    error AlreadyInitialized();
    error NotOwner();
    error NotAgentOrOwner();
    error NotBeneficiary();
    error ZeroAddress();
    error InvalidTtl();
    error Expired();
    error NotExpired();
    error AlreadyTriggered();
    error NotTriggered();
    error CancelNotProposed();
    error TooManyTokens();
    error TokenAlreadyAdded();
    error TokenNotRegistered();
    error EthTransferFailed();

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    /// @dev Owner actions are only possible while the switch is live.
    modifier whileLive() {
        _whileLive();
        _;
    }

    /// @dev The implementation contract itself can never be initialized or used.
    constructor() {
        _initialized = true;
    }

    /// @notice Backwards-compatible one-time setup without reason string.
    function initialize(address owner_, address agent_, address beneficiary_, uint64 ttl_, address[] calldata tokens_)
        external
    {
        initialize(owner_, agent_, beneficiary_, ttl_, tokens_, "");
    }

    /// @notice One-time setup, called by the factory in the clone's creation transaction.
    function initialize(
        address owner_,
        address agent_,
        address beneficiary_,
        uint64 ttl_,
        address[] calldata tokens_,
        string calldata reason_
    ) public {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (owner_ == address(0) || agent_ == address(0) || beneficiary_ == address(0)) revert ZeroAddress();
        _checkTtl(ttl_);
        owner = owner_;
        agent = agent_;
        beneficiary = beneficiary_;
        ttl = ttl_;
        lastPing = uint64(block.timestamp);
        reason = reason_;
        emit Initialized(owner_, agent_, beneficiary_, ttl_);
        for (uint256 i; i < tokens_.length; ++i) {
            _addToken(tokens_[i]);
        }
    }

    // ---- views --------------------------------------------------------------------------------

    /// @notice The switch can be triggered once `block.timestamp` is strictly greater than this.
    function deadline() public view returns (uint64) {
        return lastPing + ttl;
    }

    function expired() public view returns (bool) {
        return block.timestamp > deadline();
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    /// @notice Everything a keeper or UI needs in one call.
    function status()
        external
        view
        returns (bool triggered_, bool expired_, uint64 deadline_, uint64 lastPing_, uint64 ttl_)
    {
        return (triggered, expired(), deadline(), lastPing, ttl);
    }

    // ---- liveness -----------------------------------------------------------------------------

    /// @notice "I am alive": pushes the deadline to `now + ttl`. Agent or owner, while live.
    function ping() external whileLive {
        if (msg.sender != agent && msg.sender != owner) revert NotAgentOrOwner();
        _ping();
    }

    // ---- deposits -----------------------------------------------------------------------------

    /// @notice ETH may be sent directly (before or after triggering; see `sweep`).
    receive() external payable {
        emit Deposited(msg.sender, address(0), msg.value);
    }

    /// @notice Pulls `amount` of a registered token from the caller (requires approval).
    /// @return received What actually arrived (less than `amount` for fee-on-transfer tokens).
    function deposit(address token, uint256 amount) external nonReentrant returns (uint256 received) {
        if (triggered) revert AlreadyTriggered();
        if (!isToken[token]) revert TokenNotRegistered();
        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        received = t.balanceOf(address(this)) - before;
        emit Deposited(msg.sender, token, received);
    }

    // ---- owner --------------------------------------------------------------------------------

    /// @notice Withdraws to the owner while live. `token == address(0)` means ETH;
    /// `amount == type(uint256).max` means the whole balance.
    function withdraw(address token, uint256 amount) external onlyOwner whileLive nonReentrant {
        if (token == address(0)) {
            if (amount == type(uint256).max) amount = address(this).balance;
            emit Withdrawn(token, amount);
            (bool ok,) = owner.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20 t = IERC20(token);
            if (amount == type(uint256).max) amount = t.balanceOf(address(this));
            emit Withdrawn(token, amount);
            t.safeTransfer(owner, amount);
        }
    }

    function setAgent(address agent_) external onlyOwner whileLive {
        if (agent_ == address(0)) revert ZeroAddress();
        agent = agent_;
        emit AgentChanged(agent_);
    }

    function setBeneficiary(address beneficiary_) external onlyOwner whileLive {
        if (beneficiary_ == address(0)) revert ZeroAddress();
        beneficiary = beneficiary_;
        emit BeneficiaryChanged(beneficiary_);
    }

    /// @notice Changes the TTL. Also counts as a ping, so a shorter TTL can never expire the
    /// switch on the spot.
    function setTtl(uint64 ttl_) external onlyOwner whileLive {
        _checkTtl(ttl_);
        ttl = ttl_;
        emit TtlChanged(ttl_);
        _ping();
    }

    function addToken(address token) external onlyOwner whileLive {
        _addToken(token);
    }

    /// @notice Unregisters a token. Its balance stays; it can still be withdrawn or swept.
    function removeToken(address token) external onlyOwner whileLive {
        if (!isToken[token]) revert TokenNotRegistered();
        isToken[token] = false;
        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            if (_tokens[i] == token) {
                _tokens[i] = _tokens[n - 1];
                _tokens.pop();
                break;
            }
        }
        emit TokenRemoved(token);
    }

    // ---- mutual cancellation ------------------------------------------------------------------

    /// @notice Proposes mutual cancellation of the switch while live. Owner only.
    function proposeCancel() external onlyOwner whileLive {
        cancelProposed = true;
        emit CancelProposed();
    }

    /// @notice Revokes a pending cancellation proposal. Owner only.
    function revokeCancel() external onlyOwner whileLive {
        cancelProposed = false;
        emit CancelProposalRevoked();
    }

    /// @notice Confirms cancellation and returns all assets to the owner. Beneficiary only, while live.
    /// Terminal: marks the switch triggered so it cannot be reused, pinged, or triggered again.
    function approveCancel() external whileLive nonReentrant {
        if (msg.sender != beneficiary) revert NotBeneficiary();
        if (!cancelProposed) revert CancelNotProposed();
        triggered = true;
        cancelProposed = false;
        address to = owner;
        emit Cancelled(msg.sender);

        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            IERC20 t = IERC20(_tokens[i]);
            uint256 bal = _balanceOf(t);
            if (bal == 0) continue;
            if (t.trySafeTransfer(to, bal)) emit Transferred(address(t), to, bal);
            else emit TransferFailed(address(t), bal);
        }
        uint256 eth = address(this).balance;
        if (eth > 0) {
            (bool ok,) = to.call{value: eth}("");
            if (ok) emit Transferred(address(0), to, eth);
            else emit TransferFailed(address(0), eth);
        }
    }

    // ---- dead man's switch --------------------------------------------------------------------

    /// @notice Anyone may call this once the deadline has passed. Sends every registered token's
    /// full balance and all ETH to the beneficiary. Terminal.
    /// @dev A token or recipient that reverts cannot block the switch: the failure is logged
    /// (`TransferFailed`) and that asset stays here for `sweep()`.
    function trigger() external nonReentrant {
        if (triggered) revert AlreadyTriggered();
        if (block.timestamp <= deadline()) revert NotExpired();
        triggered = true;
        address to = beneficiary;
        emit Triggered(msg.sender, to);

        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            IERC20 t = IERC20(_tokens[i]);
            uint256 bal = _balanceOf(t);
            if (bal == 0) continue;
            if (t.trySafeTransfer(to, bal)) emit Transferred(address(t), to, bal);
            else emit TransferFailed(address(t), bal);
        }
        uint256 eth = address(this).balance;
        if (eth > 0) {
            (bool ok,) = to.call{value: eth}("");
            if (ok) emit Transferred(address(0), to, eth);
            else emit TransferFailed(address(0), eth);
        }
    }

    /// @notice After triggering, anyone may forward the remaining balance of any token
    /// (`address(0)` = ETH) to the beneficiary.
    function sweep(address token) external nonReentrant {
        if (!triggered) revert NotTriggered();
        address to = beneficiary;
        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20 t = IERC20(token);
            amount = t.balanceOf(address(this));
            t.safeTransfer(to, amount);
        }
        emit Swept(token, amount);
    }

    // ---- internals ----------------------------------------------------------------------------

    function _onlyOwner() private view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _whileLive() private view {
        if (triggered) revert AlreadyTriggered();
        if (block.timestamp > deadline()) revert Expired();
    }

    function _ping() private {
        lastPing = uint64(block.timestamp);
        emit Pinged(msg.sender, deadline());
    }

    function _checkTtl(uint64 ttl_) private pure {
        if (ttl_ < MIN_TTL || ttl_ > MAX_TTL) revert InvalidTtl();
    }

    function _addToken(address token) private {
        if (token == address(0)) revert ZeroAddress();
        if (isToken[token]) revert TokenAlreadyAdded();
        if (_tokens.length >= MAX_TOKENS) revert TooManyTokens();
        isToken[token] = true;
        _tokens.push(token);
        emit TokenAdded(token);
    }

    /// @dev balanceOf that cannot revert or return garbage (a broken token must not block trigger).
    function _balanceOf(IERC20 t) private view returns (uint256 bal) {
        (bool ok, bytes memory data) = address(t).staticcall(abi.encodeCall(IERC20.balanceOf, (address(this))));
        if (ok && data.length >= 32) bal = abi.decode(data, (uint256));
    }
}
