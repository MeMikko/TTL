// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DeadMansSwitch} from "../src/DeadMansSwitch.sol";
import {DeadMansSwitchFactory} from "../src/DeadMansSwitchFactory.sol";
import {BlocklistToken, BrokenToken, FeeOnTransferToken, MockToken, RebasingToken} from "./mocks/Tokens.sol";
import {EthRejecter, ReentrantReceiver} from "./mocks/Actors.sol";

contract DeadMansSwitchTest is Test {
    DeadMansSwitchFactory factory;
    DeadMansSwitch sw;
    MockToken token;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address beneficiary = makeAddr("beneficiary");
    address stranger = makeAddr("stranger");
    uint64 constant TTL = 1 days;

    function setUp() public {
        vm.warp(1_800_000_000);
        factory = new DeadMansSwitchFactory();
        token = new MockToken();
        sw = _create(beneficiary, _one(address(token)), bytes32(0));
        token.mint(address(sw), 1_000e18);
        vm.deal(address(sw), 5 ether);
    }

    function _one(address t) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = t;
    }

    function _create(address to, address[] memory tokens, bytes32 salt) internal returns (DeadMansSwitch) {
        vm.prank(owner);
        return DeadMansSwitch(factory.createSwitch(agent, to, TTL, tokens, salt));
    }

    function _expire() internal {
        vm.warp(sw.deadline() + 1);
    }

    // ---- factory / init -----------------------------------------------------------------------

    function test_factoryCreatesInitializedClone() public view {
        assertEq(sw.owner(), owner);
        assertEq(sw.agent(), agent);
        assertEq(sw.beneficiary(), beneficiary);
        assertEq(sw.ttl(), TTL);
        assertEq(sw.lastPing(), block.timestamp);
        assertEq(sw.deadline(), block.timestamp + TTL);
        assertTrue(sw.isToken(address(token)));
        assertEq(sw.tokens().length, 1);
        assertFalse(sw.triggered());
    }

    function test_factoryPredictsAddressAndForwardsEth() public {
        address predicted = factory.predictAddress(owner, bytes32("x"));
        vm.deal(owner, 1 ether);
        vm.expectEmit(true, true, true, true, address(factory));
        emit DeadMansSwitchFactory.SwitchCreated(predicted, owner, agent, beneficiary, TTL);
        vm.prank(owner);
        address created = factory.createSwitch{value: 1 ether}(agent, beneficiary, TTL, new address[](0), bytes32("x"));
        assertEq(created, predicted);
        assertEq(created.balance, 1 ether);
        // Same owner + salt cannot be reused; another owner gets a different address.
        vm.prank(owner);
        vm.expectRevert();
        factory.createSwitch(agent, beneficiary, TTL, new address[](0), bytes32("x"));
        assertTrue(factory.predictAddress(stranger, bytes32("x")) != predicted);
    }

    function test_cannotReinitialize() public {
        vm.expectRevert(DeadMansSwitch.AlreadyInitialized.selector);
        sw.initialize(stranger, stranger, stranger, TTL, new address[](0));
    }

    function test_implementationIsLocked() public {
        DeadMansSwitch impl = DeadMansSwitch(payable(factory.implementation()));
        vm.expectRevert(DeadMansSwitch.AlreadyInitialized.selector);
        impl.initialize(stranger, stranger, stranger, TTL, new address[](0));
    }

    function test_initValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(DeadMansSwitch.ZeroAddress.selector);
        factory.createSwitch(address(0), beneficiary, TTL, new address[](0), bytes32("a"));
        vm.expectRevert(DeadMansSwitch.ZeroAddress.selector);
        factory.createSwitch(agent, address(0), TTL, new address[](0), bytes32("b"));
        vm.expectRevert(DeadMansSwitch.InvalidTtl.selector);
        factory.createSwitch(agent, beneficiary, 59 minutes, new address[](0), bytes32("c"));
        vm.expectRevert(DeadMansSwitch.InvalidTtl.selector);
        factory.createSwitch(agent, beneficiary, 366 days, new address[](0), bytes32("d"));
        address[] memory dup = new address[](2);
        dup[0] = address(token);
        dup[1] = address(token);
        vm.expectRevert(DeadMansSwitch.TokenAlreadyAdded.selector);
        factory.createSwitch(agent, beneficiary, TTL, dup, bytes32("e"));
        vm.stopPrank();
    }

    // ---- reason & factory registry ------------------------------------------------------------

    function test_reasonStringAndOverloads() public {
        vm.prank(owner);
        DeadMansSwitch custom = DeadMansSwitch(
            factory.createSwitch(
                agent, beneficiary, TTL, new address[](0), bytes32("custom_reason"), "agent sentinel heartbeat"
            )
        );
        assertEq(custom.reason(), "agent sentinel heartbeat");
        assertEq(sw.reason(), "");
    }

    function test_factoryRegistry() public {
        address[] memory ownerList = factory.getSwitchesByOwner(owner);
        assertEq(ownerList.length, 1);
        assertEq(ownerList[0], address(sw));
        assertEq(factory.getSwitchCountByOwner(owner), 1);
        assertEq(factory.getSwitchCountByOwner(stranger), 0);

        vm.prank(stranger);
        address s2 = factory.createSwitch(agent, beneficiary, TTL, new address[](0), bytes32("s2"));

        assertEq(factory.getSwitchCountByOwner(stranger), 1);
        assertEq(factory.getSwitchesByOwner(stranger)[0], s2);
        assertEq(factory.totalSwitches(), 2);
        assertEq(factory.getAllSwitches().length, 2);
    }

    // ---- mutual cancellation ------------------------------------------------------------------

    function test_mutualCancelWorkflow() public {
        assertFalse(sw.cancelProposed());
        vm.prank(owner);
        vm.expectEmit(false, false, false, false, address(sw));
        emit DeadMansSwitch.CancelProposed();
        sw.proposeCancel();
        assertTrue(sw.cancelProposed());

        uint256 ownerEthBefore = owner.balance;
        uint256 ownerTokenBefore = token.balanceOf(owner);

        vm.prank(beneficiary);
        vm.expectEmit(true, false, false, false, address(sw));
        emit DeadMansSwitch.Cancelled(beneficiary);
        sw.approveCancel();

        assertTrue(sw.triggered());
        assertFalse(sw.cancelProposed());
        assertEq(owner.balance, ownerEthBefore + 5 ether);
        assertEq(token.balanceOf(owner), ownerTokenBefore + 1_000e18);
        assertEq(address(sw).balance, 0);
        assertEq(token.balanceOf(address(sw)), 0);

        // Terminal: cannot ping, withdraw, or trigger
        vm.prank(agent);
        vm.expectRevert(DeadMansSwitch.AlreadyTriggered.selector);
        sw.ping();

        vm.prank(owner);
        vm.expectRevert(DeadMansSwitch.AlreadyTriggered.selector);
        sw.withdraw(address(0), 1 ether);

        vm.prank(stranger);
        vm.expectRevert(DeadMansSwitch.AlreadyTriggered.selector);
        sw.trigger();
    }

    function test_mutualCancelValidation() public {
        // Beneficiary cannot approve without proposal
        vm.prank(beneficiary);
        vm.expectRevert(DeadMansSwitch.CancelNotProposed.selector);
        sw.approveCancel();

        // Stranger cannot propose
        vm.prank(stranger);
        vm.expectRevert(DeadMansSwitch.NotOwner.selector);
        sw.proposeCancel();

        // Owner proposes
        vm.prank(owner);
        sw.proposeCancel();

        // Stranger cannot approve
        vm.prank(stranger);
        vm.expectRevert(DeadMansSwitch.NotBeneficiary.selector);
        sw.approveCancel();

        // Owner revokes proposal
        vm.prank(owner);
        vm.expectEmit(false, false, false, false, address(sw));
        emit DeadMansSwitch.CancelProposalRevoked();
        sw.revokeCancel();
        assertFalse(sw.cancelProposed());

        // Beneficiary cannot approve after revoke
        vm.prank(beneficiary);
        vm.expectRevert(DeadMansSwitch.CancelNotProposed.selector);
        sw.approveCancel();
    }

    function test_mutualCancelBlockedAfterExpiry() public {
        _expire();
        vm.prank(owner);
        vm.expectRevert(DeadMansSwitch.Expired.selector);
        sw.proposeCancel();
    }

    // ---- ping ---------------------------------------------------------------------------------

    function test_agentAndOwnerCanPing() public {
        vm.warp(block.timestamp + 10 hours);
        vm.expectEmit(true, false, false, true, address(sw));
        emit DeadMansSwitch.Pinged(agent, uint64(block.timestamp + TTL));
        vm.prank(agent);
        sw.ping();
        assertEq(sw.lastPing(), block.timestamp);

        vm.warp(block.timestamp + 10 hours);
        vm.prank(owner);
        sw.ping();
        assertEq(sw.deadline(), block.timestamp + TTL);
    }

    function test_strangerCannotPing() public {
        vm.prank(stranger);
        vm.expectRevert(DeadMansSwitch.NotAgentOrOwner.selector);
        sw.ping();
    }

    function test_pingAtExactDeadlineStillCounts() public {
        vm.warp(sw.deadline());
        vm.prank(agent);
        sw.ping();
        assertFalse(sw.expired());
    }

    function test_cannotPingAfterExpiry() public {
        _expire();
        vm.prank(agent);
        vm.expectRevert(DeadMansSwitch.Expired.selector);
        sw.ping();
        vm.prank(owner);
        vm.expectRevert(DeadMansSwitch.Expired.selector);
        sw.ping();
    }

    // ---- trigger ------------------------------------------------------------------------------

    function test_triggerRevertsBeforeDeadline() public {
        vm.warp(sw.deadline());
        vm.expectRevert(DeadMansSwitch.NotExpired.selector);
        sw.trigger();
    }

    function test_anyoneCanTriggerAfterDeadline() public {
        _expire();
        vm.expectEmit(true, true, false, false, address(sw));
        emit DeadMansSwitch.Triggered(stranger, beneficiary);
        vm.prank(stranger);
        sw.trigger();
        assertTrue(sw.triggered());
        assertEq(token.balanceOf(beneficiary), 1_000e18);
        assertEq(beneficiary.balance, 5 ether);
        assertEq(token.balanceOf(address(sw)), 0);
        assertEq(address(sw).balance, 0);
    }

    function test_triggerRewardPaysCallerAndRestToBeneficiary() public {
        address[] memory none = new address[](0);
        vm.prank(owner);
        DeadMansSwitch s = DeadMansSwitch(
            factory.createSwitch(agent, beneficiary, TTL, none, bytes32("rew"), "", 250) // 2.5%
        );
        vm.deal(address(s), 10 ether);
        assertEq(s.triggerRewardBps(), 250);
        vm.warp(s.deadline() + 1);

        vm.expectEmit(true, false, false, true, address(s));
        emit DeadMansSwitch.TriggerRewardPaid(stranger, 0.25 ether);
        vm.prank(stranger);
        s.trigger();
        assertEq(stranger.balance, 0.25 ether); // 2.5% of 10
        assertEq(beneficiary.balance, 9.75 ether);
        assertEq(address(s).balance, 0);
    }

    function test_triggerRewardDefaultsToZero() public {
        _expire();
        vm.prank(stranger);
        sw.trigger();
        assertEq(stranger.balance, 0);
        assertEq(beneficiary.balance, 5 ether);
    }

    function test_triggerRewardCapEnforced() public {
        address[] memory none = new address[](0);
        vm.prank(owner);
        vm.expectRevert(DeadMansSwitch.InvalidRewardBps.selector);
        factory.createSwitch(agent, beneficiary, TTL, none, bytes32("bad"), "", 501); // > 5%
    }

    function test_triggerRewardBestEffortWhenCallerRejectsEth() public {
        // A contract caller that rejects ETH still triggers; the reward simply goes to the beneficiary.
        EthRejecter caller = new EthRejecter();
        address[] memory none = new address[](0);
        vm.prank(owner);
        DeadMansSwitch s = DeadMansSwitch(factory.createSwitch(agent, beneficiary, TTL, none, bytes32("rej2"), "", 500));
        vm.deal(address(s), 4 ether);
        vm.warp(s.deadline() + 1);
        vm.prank(address(caller));
        s.trigger();
        assertTrue(s.triggered());
        assertEq(address(caller).balance, 0); // reward bounced
        assertEq(beneficiary.balance, 4 ether); // everything reached the beneficiary
        assertEq(address(s).balance, 0);
    }

    // ---- payout redirect (escape hatch for a beneficiary that cannot receive) ------------------

    function test_setPayoutAddressOnlyBeneficiary() public {
        vm.prank(owner);
        vm.expectRevert(DeadMansSwitch.NotBeneficiary.selector);
        sw.setPayoutAddress(owner);
        vm.prank(stranger);
        vm.expectRevert(DeadMansSwitch.NotBeneficiary.selector);
        sw.setPayoutAddress(stranger);
        vm.prank(beneficiary);
        vm.expectRevert(DeadMansSwitch.ZeroAddress.selector);
        sw.setPayoutAddress(address(0));
    }

    function test_payoutRedirectRescuesEthWhenBeneficiaryRejects() public {
        // Beneficiary is a contract that rejects ETH: trigger leaves the ETH stuck here.
        EthRejecter rej = new EthRejecter();
        address[] memory none = new address[](0);
        vm.prank(owner);
        DeadMansSwitch s = DeadMansSwitch(factory.createSwitch(agent, address(rej), TTL, none, bytes32("po1")));
        vm.deal(address(s), 3 ether);
        vm.warp(s.deadline() + 1);
        s.trigger();
        assertEq(address(s).balance, 3 ether); // stuck: beneficiary rejected it
        assertEq(address(rej).balance, 0);

        // The beneficiary redirects to a reachable address; anyone can then sweep it out.
        address payout = makeAddr("payout");
        vm.prank(address(rej));
        s.setPayoutAddress(payout);
        s.sweep(address(0));
        assertEq(payout.balance, 3 ether);
        assertEq(address(s).balance, 0);
    }

    function test_payoutRedirectRescuesBlocklistedToken() public {
        // USDC-style: the token reverts transfers to the (blocklisted) beneficiary.
        BlocklistToken bt = new BlocklistToken();
        address blocked = makeAddr("blockedBeneficiary");
        bt.setBlocked(blocked);
        vm.prank(owner);
        DeadMansSwitch s = DeadMansSwitch(factory.createSwitch(agent, blocked, TTL, _one(address(bt)), bytes32("po2")));
        bt.mint(address(s), 500e18);
        vm.warp(s.deadline() + 1);
        s.trigger();
        assertEq(bt.balanceOf(address(s)), 500e18); // stuck: transfer to blocked beneficiary reverted

        address payout = makeAddr("payout2");
        vm.prank(blocked); // a blocklisted address can still send transactions
        s.setPayoutAddress(payout);
        s.sweep(address(bt));
        assertEq(bt.balanceOf(payout), 500e18);
        assertEq(bt.balanceOf(address(s)), 0);
    }

    function test_triggerUsesPayoutWhenSetBeforeExpiry() public {
        address payout = makeAddr("payout3");
        vm.prank(beneficiary);
        sw.setPayoutAddress(payout);
        _expire();
        sw.trigger();
        assertEq(token.balanceOf(payout), 1_000e18);
        assertEq(payout.balance, 5 ether);
        assertEq(token.balanceOf(beneficiary), 0);
        assertEq(beneficiary.balance, 0);
    }

    function test_setBeneficiaryClearsPayoutRedirect() public {
        address payout = makeAddr("oldPayout");
        vm.prank(beneficiary);
        sw.setPayoutAddress(payout);
        // Owner rotates the beneficiary while live; the old redirect must not capture the new one.
        address newBen = makeAddr("newBeneficiary");
        vm.prank(owner);
        sw.setBeneficiary(newBen);
        assertEq(sw.payoutAddress(), address(0));
        _expire();
        sw.trigger();
        assertEq(token.balanceOf(newBen), 1_000e18);
        assertEq(newBen.balance, 5 ether);
        assertEq(token.balanceOf(payout), 0);
        assertEq(payout.balance, 0);
    }

    function test_sweepAfterCancelRoutesToOwnerNotBeneficiary() public {
        // Owner is a contract that rejects ETH. A mutual cancel returns funds to the owner, but the
        // ETH send fails and stays here. sweep() must target the owner (M1), never the beneficiary.
        EthRejecter o = new EthRejecter();
        vm.prank(address(o));
        DeadMansSwitch s =
            DeadMansSwitch(factory.createSwitch(agent, beneficiary, TTL, _one(address(token)), bytes32("cx")));
        token.mint(address(s), 100e18);
        vm.deal(address(s), 2 ether);

        vm.prank(address(o));
        s.proposeCancel();
        vm.prank(beneficiary);
        s.approveCancel();

        assertTrue(s.cancelled());
        assertEq(token.balanceOf(address(o)), 100e18); // tokens reached the owner
        assertEq(address(s).balance, 2 ether); // ETH stuck: owner rejected it

        // sweep targets the owner (reverts because the owner rejects ETH), never the beneficiary.
        vm.expectRevert(DeadMansSwitch.EthTransferFailed.selector);
        s.sweep(address(0));
        assertEq(beneficiary.balance, 0);
        assertEq(address(s).balance, 2 ether);
    }

    function test_triggerEventReportsBeneficiaryEvenWithRedirect() public {
        address payout = makeAddr("payoutEvt");
        vm.prank(beneficiary);
        sw.setPayoutAddress(payout);
        _expire();
        // Event logs the literal beneficiary; funds go to the redirect.
        vm.expectEmit(true, true, false, false, address(sw));
        emit DeadMansSwitch.Triggered(stranger, beneficiary);
        vm.prank(stranger);
        sw.trigger();
        assertEq(payout.balance, 5 ether);
        assertEq(beneficiary.balance, 0);
    }

    function test_triggerIsTerminal() public {
        _expire();
        sw.trigger();
        vm.expectRevert(DeadMansSwitch.AlreadyTriggered.selector);
        sw.trigger();
        vm.startPrank(owner);
        vm.expectRevert(DeadMansSwitch.AlreadyTriggered.selector);
        sw.withdraw(address(0), 1);
        vm.expectRevert(DeadMansSwitch.AlreadyTriggered.selector);
        sw.setBeneficiary(owner);
        vm.stopPrank();
    }

    function test_expiredSwitchIsCommitted() public {
        _expire();
        vm.startPrank(owner);
        vm.expectRevert(DeadMansSwitch.Expired.selector);
        sw.withdraw(address(0), 1 ether);
        vm.expectRevert(DeadMansSwitch.Expired.selector);
        sw.setBeneficiary(owner);
        vm.expectRevert(DeadMansSwitch.Expired.selector);
        sw.setTtl(TTL);
        vm.expectRevert(DeadMansSwitch.Expired.selector);
        sw.removeToken(address(token));
        vm.stopPrank();
    }

    function test_triggerWithTwentyTokensAndBoundedGas() public {
        address[] memory list = new address[](20);
        for (uint256 i; i < 20; ++i) {
            MockToken t = new MockToken();
            list[i] = address(t);
        }
        DeadMansSwitch s = _create(beneficiary, list, bytes32("twenty"));
        for (uint256 i; i < 20; ++i) {
            MockToken(list[i]).mint(address(s), 1e18);
        }
        vm.warp(s.deadline() + 1);
        uint256 gasBefore = gasleft();
        s.trigger();
        uint256 used = gasBefore - gasleft();
        assertLt(used, 1_000_000, "trigger must stay cheap enough for any keeper");
        for (uint256 i; i < 20; ++i) {
            assertEq(MockToken(list[i]).balanceOf(beneficiary), 1e18);
        }
    }

    function test_tokenCapIsTwenty() public {
        vm.startPrank(owner);
        for (uint256 i = 1; i < 20; ++i) {
            sw.addToken(address(new MockToken()));
        }
        address extra = address(new MockToken());
        vm.expectRevert(DeadMansSwitch.TooManyTokens.selector);
        sw.addToken(extra);
        sw.removeToken(address(token));
        sw.addToken(extra);
        vm.stopPrank();
        assertEq(sw.tokens().length, 20);
    }

    function test_brokenTokenCannotBlockTrigger() public {
        BrokenToken bad = new BrokenToken();
        vm.prank(owner);
        sw.addToken(address(bad));
        bad.mint(address(sw), 7e18);
        bad.setBroken(true);
        _expire();
        vm.expectEmit(true, false, false, true, address(sw));
        emit DeadMansSwitch.TransferFailed(address(bad), 7e18);
        sw.trigger();
        // Everything else arrived; the stuck token can be swept once it works again.
        assertEq(token.balanceOf(beneficiary), 1_000e18);
        assertEq(beneficiary.balance, 5 ether);
        bad.setBroken(false);
        sw.sweep(address(bad));
        assertEq(bad.balanceOf(beneficiary), 7e18);
    }

    function test_ethRejectingBeneficiaryCannotBlockTokens() public {
        EthRejecter rejecter = new EthRejecter();
        DeadMansSwitch s = _create(address(rejecter), _one(address(token)), bytes32("rej"));
        token.mint(address(s), 3e18);
        vm.deal(address(s), 1 ether);
        vm.warp(s.deadline() + 1);
        s.trigger();
        assertTrue(s.triggered());
        assertEq(token.balanceOf(address(rejecter)), 3e18);
        assertEq(address(s).balance, 1 ether); // stays; sweep reverts while the recipient rejects ETH
        vm.expectRevert(DeadMansSwitch.EthTransferFailed.selector);
        s.sweep(address(0));
    }

    // ---- sweep --------------------------------------------------------------------------------

    function test_sweepForwardsLateAndUnregisteredAssets() public {
        MockToken other = new MockToken();
        other.mint(address(sw), 2e18); // never registered
        _expire();
        sw.trigger();
        vm.deal(address(sw), 1 ether); // late ETH
        token.mint(address(sw), 4e18); // late token
        vm.startPrank(stranger);
        sw.sweep(address(0));
        sw.sweep(address(token));
        sw.sweep(address(other));
        vm.stopPrank();
        assertEq(beneficiary.balance, 6 ether);
        assertEq(token.balanceOf(beneficiary), 1_004e18);
        assertEq(other.balanceOf(beneficiary), 2e18);
    }

    function test_sweepRequiresTrigger() public {
        vm.expectRevert(DeadMansSwitch.NotTriggered.selector);
        sw.sweep(address(0));
    }

    // ---- deposits / fee-on-transfer / rebasing -------------------------------------------------

    function test_depositPullsRegisteredToken() public {
        token.mint(stranger, 10e18);
        vm.startPrank(stranger);
        token.approve(address(sw), 10e18);
        assertEq(sw.deposit(address(token), 10e18), 10e18);
        MockToken other = new MockToken();
        vm.expectRevert(DeadMansSwitch.TokenNotRegistered.selector);
        sw.deposit(address(other), 1);
        vm.stopPrank();
        assertEq(token.balanceOf(address(sw)), 1_010e18);
    }

    function test_feeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(100); // 1 %
        vm.prank(owner);
        sw.addToken(address(fot));
        fot.mint(stranger, 100e18);
        vm.startPrank(stranger);
        fot.approve(address(sw), 100e18);
        uint256 received = sw.deposit(address(fot), 100e18);
        vm.stopPrank();
        assertEq(received, 99e18, "deposit reports what actually arrived");
        _expire();
        sw.trigger();
        // The switch sends its live balance; the beneficiary gets it minus the token's own fee,
        // and nothing is left behind.
        assertEq(fot.balanceOf(address(sw)), 0);
        assertEq(fot.balanceOf(beneficiary), 99e18 - 99e18 / 100);
    }

    function test_rebasingToken() public {
        RebasingToken reb = new RebasingToken();
        vm.prank(owner);
        sw.addToken(address(reb));
        reb.mint(address(sw), 100e18);
        reb.rebase(12_000); // +20 %
        _expire();
        sw.trigger();
        assertEq(reb.balanceOf(beneficiary), 120e18);
        assertEq(reb.balanceOf(address(sw)), 0);
    }

    // ---- owner functions ----------------------------------------------------------------------

    function test_ownerWithdrawsWhileLive() public {
        vm.startPrank(owner);
        sw.withdraw(address(0), 2 ether);
        sw.withdraw(address(token), type(uint256).max);
        vm.stopPrank();
        assertEq(owner.balance, 2 ether);
        assertEq(token.balanceOf(owner), 1_000e18);
    }

    function test_onlyOwnerManages() public {
        vm.startPrank(agent);
        vm.expectRevert(DeadMansSwitch.NotOwner.selector);
        sw.withdraw(address(0), 1);
        vm.expectRevert(DeadMansSwitch.NotOwner.selector);
        sw.setAgent(agent);
        vm.expectRevert(DeadMansSwitch.NotOwner.selector);
        sw.setBeneficiary(agent);
        vm.expectRevert(DeadMansSwitch.NotOwner.selector);
        sw.setTtl(TTL);
        vm.expectRevert(DeadMansSwitch.NotOwner.selector);
        sw.addToken(address(1));
        vm.expectRevert(DeadMansSwitch.NotOwner.selector);
        sw.removeToken(address(token));
        vm.stopPrank();
    }

    function test_setTtlCountsAsPing() public {
        vm.warp(block.timestamp + 20 hours);
        vm.prank(owner);
        sw.setTtl(1 hours); // shorter than the time since the last ping: must not expire now
        assertEq(sw.lastPing(), block.timestamp);
        assertFalse(sw.expired());
        assertEq(sw.deadline(), block.timestamp + 1 hours);
    }

    function test_setAgentAndBeneficiary() public {
        address newAgent = makeAddr("newAgent");
        address newBen = makeAddr("newBen");
        vm.startPrank(owner);
        sw.setAgent(newAgent);
        sw.setBeneficiary(newBen);
        vm.expectRevert(DeadMansSwitch.ZeroAddress.selector);
        sw.setAgent(address(0));
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(DeadMansSwitch.NotAgentOrOwner.selector);
        sw.ping();
        vm.prank(newAgent);
        sw.ping();
        _expire();
        sw.trigger();
        assertEq(newBen.balance, 5 ether);
    }

    // ---- reentrancy ---------------------------------------------------------------------------

    function test_reentrantBeneficiaryCannotReenterTrigger() public {
        ReentrantReceiver r = new ReentrantReceiver();
        DeadMansSwitch s = _create(address(r), new address[](0), bytes32("re"));
        vm.deal(address(s), 1 ether);
        r.arm(s, abi.encodeCall(DeadMansSwitch.sweep, (address(0))));
        vm.warp(s.deadline() + 1);
        s.trigger();
        assertTrue(r.reentered());
        assertFalse(r.reentrySucceeded(), "sweep during trigger must be blocked");
        assertEq(address(r).balance, 1 ether);
    }

    function test_reentrantOwnerCannotDoubleWithdraw() public {
        ReentrantReceiver r = new ReentrantReceiver();
        vm.prank(address(r));
        DeadMansSwitch s =
            DeadMansSwitch(factory.createSwitch(agent, beneficiary, TTL, new address[](0), bytes32("ro")));
        vm.deal(address(s), 2 ether);
        r.arm(s, abi.encodeCall(DeadMansSwitch.withdraw, (address(0), 1 ether)));
        vm.prank(address(r));
        s.withdraw(address(0), 1 ether);
        assertTrue(r.reentered());
        assertFalse(r.reentrySucceeded());
        assertEq(address(s).balance, 1 ether);
    }

    // ---- fuzz ---------------------------------------------------------------------------------

    function testFuzz_triggerOnlyAfterDeadline(uint64 ttl, uint64 pingAfter, uint64 triggerAfter) public {
        ttl = uint64(bound(ttl, sw.MIN_TTL(), sw.MAX_TTL()));
        vm.prank(owner);
        sw.setTtl(ttl);
        pingAfter = uint64(bound(pingAfter, 0, ttl)); // agent pings while live
        vm.warp(block.timestamp + pingAfter);
        vm.prank(agent);
        sw.ping();
        uint256 deadline = block.timestamp + ttl;
        assertEq(sw.deadline(), deadline);

        triggerAfter = uint64(bound(triggerAfter, 0, uint256(ttl) * 2));
        vm.warp(block.timestamp + triggerAfter);
        if (block.timestamp <= deadline) {
            vm.expectRevert(DeadMansSwitch.NotExpired.selector);
            sw.trigger();
            assertFalse(sw.triggered());
        } else {
            sw.trigger();
            assertTrue(sw.triggered());
            assertEq(beneficiary.balance, 5 ether);
        }
    }

    function testFuzz_ttlBounds(uint64 ttl) public {
        bool valid = ttl >= sw.MIN_TTL() && ttl <= sw.MAX_TTL();
        vm.prank(owner);
        if (!valid) {
            vm.expectRevert(DeadMansSwitch.InvalidTtl.selector);
            sw.setTtl(ttl);
        } else {
            sw.setTtl(ttl);
            assertEq(sw.ttl(), ttl);
        }
    }

    function testFuzz_feeOnTransferNeverLeavesDust(uint16 feeBps, uint96 amount) public {
        feeBps = uint16(bound(feeBps, 0, 5_000));
        FeeOnTransferToken fot = new FeeOnTransferToken(feeBps);
        vm.prank(owner);
        sw.addToken(address(fot));
        fot.mint(address(sw), amount);
        _expire();
        sw.trigger();
        assertEq(fot.balanceOf(address(sw)), 0);
        assertEq(fot.balanceOf(beneficiary), uint256(amount) - uint256(amount) * feeBps / 10_000);
    }
}
