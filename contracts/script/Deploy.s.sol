// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {DeadMansSwitchFactory} from "../src/DeadMansSwitchFactory.sol";

/// @notice Deploys the factory with a fixed salt.
///
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast --verify
///
/// IMPORTANT: for a salted (CREATE2) deploy, the address seen in simulation does NOT reliably match
/// the real on-chain address foundry broadcasts to. Do not trust any address printed by this script.
/// Take the factory address from the "Contract Address:" line in the broadcast output (also saved in
/// `broadcast/Deploy.s.sol/<chainid>/run-latest.json`), and then set the keeper env:
///   KEEPER_FACTORY_ADDRESS = that address
///   KEEPER_FROM_BLOCK      = the "Block:" that transaction landed in
/// Confirm it with `cast call <addr> "totalSwitches()(uint256)" --rpc-url base_sepolia` (expect 0).
contract Deploy is Script {
    bytes32 constant SALT = keccak256("time2live.DeadMansSwitchFactory.v1");

    function run() external returns (DeadMansSwitchFactory factory) {
        vm.startBroadcast();
        factory = new DeadMansSwitchFactory{salt: SALT}();
        vm.stopBroadcast();

        // Simulation-only value; the authoritative address is the broadcast "Contract Address:" line.
        console.log("factory (SIMULATION address - use the broadcast 'Contract Address' instead)", address(factory));
    }
}
