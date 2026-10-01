// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Burns `feeBps` of every transfer (a typical fee-on-transfer token).
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("Fee", "FEE") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 fee = value * feeBps / 10_000;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}

/// @notice Balances change without transfers (rebasing), like stETH-style tokens.
contract RebasingToken is ERC20 {
    uint256 public multiplierBps = 10_000;

    constructor() ERC20("Rebase", "REB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function rebase(uint256 bps) external {
        multiplierBps = bps;
    }

    function balanceOf(address account) public view override returns (uint256) {
        return super.balanceOf(account) * multiplierBps / 10_000;
    }

    function _update(address from, address to, uint256 value) internal override {
        // Convert rebased units back to shares.
        super._update(from, to, value * 10_000 / multiplierBps);
    }
}

/// @notice A token whose transfers always revert (e.g. a paused or blacklisting token).
contract BrokenToken is MockToken {
    bool public broken;

    function setBroken(bool b) external {
        broken = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!broken || from == address(0), "broken");
        super._update(from, to, value);
    }
}

/// @notice A token that reverts transfers to a specific blocklisted address (like USDC/USDT), but
/// works for everyone else — the realistic case the payout-redirect escape hatch exists for.
contract BlocklistToken is MockToken {
    address public blocked;

    function setBlocked(address a) external {
        blocked = a;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to != blocked, "blocked");
        super._update(from, to, value);
    }
}

/// @notice A hostile token whose transfers burn every bit of gas they are given (a keeper griefer).
contract GasBombToken is MockToken {
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) {
            while (true) {}
        }
        super._update(from, to, value);
    }
}
