// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {DeadMansSwitchFactory} from "../src/DeadMansSwitchFactory.sol";

/// @notice Deploys the factory through the deterministic CREATE2 deployer, so it has the same
/// address on every chain (Base Sepolia, Base).
///
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast --verify
contract Deploy is Script {
    bytes32 constant SALT = keccak256("time2live.DeadMansSwitchFactory.v1");

    function run() external returns (DeadMansSwitchFactory factory) {
        vm.startBroadcast();
        factory = new DeadMansSwitchFactory{salt: SALT}();
        vm.stopBroadcast();
        console.log("DeadMansSwitchFactory", address(factory));
        console.log("implementation", factory.implementation());
        console.log("current block (use as KEEPER_FROM_BLOCK)", block.number);
    }
}
