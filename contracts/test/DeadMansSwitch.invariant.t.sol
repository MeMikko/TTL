// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DeadMansSwitch} from "../src/DeadMansSwitch.sol";
import {DeadMansSwitchFactory} from "../src/DeadMansSwitchFactory.sol";
import {FeeOnTransferToken, MockToken} from "./mocks/Tokens.sol";

/// @dev Drives random sequences of every public action by every kind of caller.
contract Handler is Test {
    DeadMansSwitch public immutable sw;
    MockToken public immutable token;
    FeeOnTransferToken public immutable fot;

    address public immutable owner;
    address public immutable agent;
    address public immutable funder = makeAddr("funder");
    address public immutable stranger = makeAddr("stranger");
    address public immutable beneficiaryA = makeAddr("beneficiaryA");
    address public immutable beneficiaryB = makeAddr("beneficiaryB");

    /// Ghosts
    bool public triggeredBeforeDeadline;
    bool public revived;
    bool public ownerTookAfterExpiry;
    uint256 public ethIn;
    uint256 public calls;
    uint256 public triggers;
    uint256 public sweeps;

    constructor(DeadMansSwitch sw_, MockToken token_, FeeOnTransferToken fot_, address owner_, address agent_) {
        sw = sw_;
        token = token_;
        fot = fot_;
        owner = owner_;
        agent = agent_;
    }

    function _caller(uint256 seed) internal view returns (address) {
        address[4] memory who = [owner, agent, stranger, beneficiaryA];
        return who[seed % 4];
    }

    function warp(uint256 secs) external {
        calls++;
        vm.warp(block.timestamp + bound(secs, 0, 3 days));
    }

    function ping(uint256 who) external {
        calls++;
        bool wasTriggered = sw.triggered();
        bool wasExpired = sw.expired();
        vm.prank(_caller(who));
        try sw.ping() {
            if (wasTriggered || wasExpired) revived = true;
        } catch {}
    }

    function depositEth(uint256 amount) external {
        calls++;
        amount = bound(amount, 0, 10 ether);
        vm.deal(funder, amount);
        vm.prank(funder);
        (bool ok,) = address(sw).call{value: amount}("");
        if (ok) ethIn += amount;
    }

    function depositToken(uint256 amount, bool feeToken) external {
        calls++;
        amount = bound(amount, 0, 1e24);
        if (feeToken) fot.mint(funder, amount);
        else token.mint(funder, amount);
        vm.startPrank(funder);
        if (feeToken) {
            fot.approve(address(sw), amount);
            try sw.deposit(address(fot), amount) {} catch {}
        } else {
            token.approve(address(sw), amount);
            try sw.deposit(address(token), amount) {} catch {}
        }
        vm.stopPrank();
    }

    function withdraw(uint256 who, uint256 amount, bool eth) external {
        calls++;
        bool expired = sw.expired() || sw.triggered();
        uint256 ownerEth = owner.balance;
        uint256 ownerTok = token.balanceOf(owner);
        vm.prank(_caller(who));
        try sw.withdraw(eth ? address(0) : address(token), bound(amount, 0, type(uint128).max)) {} catch {}
        if (expired && (owner.balance > ownerEth || token.balanceOf(owner) > ownerTok)) ownerTookAfterExpiry = true;
    }

    function setTtl(uint256 who, uint64 ttl) external {
        calls++;
        ttl = uint64(bound(ttl, 1 hours, 3 days));
        bool wasExpired = sw.expired() || sw.triggered();
        vm.prank(_caller(who));
        try sw.setTtl(ttl) {
            if (wasExpired) revived = true;
        } catch {}
    }

    function setBeneficiary(uint256 who, bool toB) external {
        calls++;
        vm.prank(_caller(who));
        try sw.setBeneficiary(toB ? beneficiaryB : beneficiaryA) {} catch {}
    }

    function trigger(uint256 who) external {
        calls++;
        uint64 deadline = sw.deadline();
        vm.prank(_caller(who));
        try sw.trigger() {
            triggers++;
            if (block.timestamp <= deadline) triggeredBeforeDeadline = true;
        } catch {}
    }

    function sweep(uint256 who, uint256 which) external {
        calls++;
        address[3] memory assets = [address(0), address(token), address(fot)];
        vm.prank(_caller(who));
        try sw.sweep(assets[which % 3]) {
            sweeps++;
        } catch {}
    }
}

contract DeadMansSwitchInvariantTest is Test {
    DeadMansSwitch sw;
    MockToken token;
    FeeOnTransferToken fot;
    Handler handler;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");

    function setUp() public {
        vm.warp(1_800_000_000);
        DeadMansSwitchFactory factory = new DeadMansSwitchFactory();
        token = new MockToken();
        fot = new FeeOnTransferToken(250);
        address[] memory list = new address[](2);
        list[0] = address(token);
        list[1] = address(fot);
        vm.prank(owner);
        sw = DeadMansSwitch(factory.createSwitch(agent, makeAddr("beneficiaryA"), 1 days, list, bytes32(0)));
        handler = new Handler(sw, token, fot, owner, agent);
        targetContract(address(handler));
    }

    /// Funds only ever reach the owner or a beneficiary: the agent, strangers and anyone else
    /// never receive anything, and all ETH is accounted for.
    function invariant_fundsOnlyReachOwnerOrBeneficiary() public view {
        address[2] memory outsiders = [agent, handler.stranger()];
        for (uint256 i; i < 2; ++i) {
            assertEq(outsiders[i].balance, 0);
            assertEq(token.balanceOf(outsiders[i]), 0);
            assertEq(fot.balanceOf(outsiders[i]), 0);
        }
        assertEq(
            address(sw).balance + owner.balance + handler.beneficiaryA().balance + handler.beneficiaryB().balance,
            handler.ethIn()
        );
    }

    function invariant_triggerImpossibleBeforeDeadline() public view {
        assertFalse(handler.triggeredBeforeDeadline());
    }

    /// Once expired, nothing revives the switch and the owner cannot pull funds.
    function invariant_expiryIsFinal() public view {
        assertFalse(handler.revived());
        assertFalse(handler.ownerTookAfterExpiry());
    }

    function invariant_stateConsistency() public view {
        assertGe(sw.ttl(), sw.MIN_TTL());
        assertLe(sw.ttl(), sw.MAX_TTL());
        assertLe(sw.lastPing(), block.timestamp);
        assertLe(sw.tokens().length, sw.MAX_TOKENS());
    }
}
