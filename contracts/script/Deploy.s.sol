// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {DeadMansSwitchFactory} from "../src/DeadMansSwitchFactory.sol";

/// @notice Deploys the factory through the deterministic CREATE2 deployer, so it has the same
/// address on every chain (Base Sepolia, Base).
///
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast --verify
///
/// Under `--broadcast`, `new{salt}` is routed through the canonical CREATE2 deployer
/// (0x4e59...), so the real on-chain address is CREATE2(deployer, SALT, initCodeHash) — NOT the
/// address the script computes in simulation from the sender. We compute and print the real one so
/// there is no ambiguity (verify with `cast call <addr> "totalSwitches()(uint256)"`).
contract Deploy is Script {
    bytes32 constant SALT = keccak256("time2live.DeadMansSwitchFactory.v1");

    function run() external returns (DeadMansSwitchFactory factory) {
        address predicted = vm.computeCreate2Address(SALT, keccak256(type(DeadMansSwitchFactory).creationCode));
        console.log("factory (deterministic CREATE2 address)", predicted);

        vm.startBroadcast();
        factory = new DeadMansSwitchFactory{salt: SALT}();
        vm.stopBroadcast();

        // Read from the returned handle, not `predicted`: in simulation the salted deploy lands at a
        // script-derived CREATE2 address (the handle), while `predicted` — the real on-chain address
        // reached via the canonical deployer under `--broadcast` — has no code yet in simulation.
        console.log("implementation", factory.implementation());
        console.log("KEEPER_FACTORY_ADDRESS", predicted);
        console.log("KEEPER_FROM_BLOCK", block.number);
    }
}
