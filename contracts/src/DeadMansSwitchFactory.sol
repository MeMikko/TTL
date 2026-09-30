// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DeadMansSwitch} from "./DeadMansSwitch.sol";

/// @title DeadMansSwitchFactory
/// @notice Creates one isolated `DeadMansSwitch` (EIP-1167 clone) per call. The caller becomes the
/// owner. Addresses are deterministic per (caller, salt), so an agent can know its switch address
/// before creating it. Keepers discover switches through `SwitchCreated`.
contract DeadMansSwitchFactory {
    address public immutable implementation;

    event SwitchCreated(
        address indexed switchAddress, address indexed owner, address indexed agent, address beneficiary, uint64 ttl
    );

    error DepositFailed();

    constructor() {
        implementation = address(new DeadMansSwitch());
    }

    /// @notice Creates and initializes a switch; any ETH sent is deposited into it.
    function createSwitch(address agent, address beneficiary, uint64 ttl, address[] calldata tokens, bytes32 salt)
        external
        payable
        returns (address payable switchAddress)
    {
        switchAddress = payable(Clones.cloneDeterministic(implementation, _salt(msg.sender, salt)));
        emit SwitchCreated(switchAddress, msg.sender, agent, beneficiary, ttl);
        DeadMansSwitch(switchAddress).initialize(msg.sender, agent, beneficiary, ttl, tokens);
        if (msg.value > 0) {
            (bool ok,) = switchAddress.call{value: msg.value}("");
            if (!ok) revert DepositFailed();
        }
    }

    function predictAddress(address owner, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(owner, salt));
    }

    function _salt(address owner, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
