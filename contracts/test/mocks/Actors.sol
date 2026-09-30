// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeadMansSwitch} from "../../src/DeadMansSwitch.sol";

/// @notice Rejects ETH.
contract EthRejecter {
    receive() external payable {
        revert("no ETH");
    }
}

/// @notice Tries to re-enter the switch when it receives ETH.
contract ReentrantReceiver {
    DeadMansSwitch public target;
    bytes public reentryCall;
    bool public reentered;
    bool public reentrySucceeded;

    function arm(DeadMansSwitch target_, bytes calldata call_) external {
        target = target_;
        reentryCall = call_;
    }

    receive() external payable {
        if (reentered) return;
        reentered = true;
        (reentrySucceeded,) = address(target).call(reentryCall);
    }
}
