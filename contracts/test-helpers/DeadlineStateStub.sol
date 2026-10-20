// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.27;

// Isolate deadline and real Groth16 verification from publishing test identities.
contract DeadlineStateStub {
    function processCrossChainProofs(bytes calldata) external pure {}

    function getStateReplacedAt(uint256, uint256) external pure returns (uint256) {
        return 0;
    }

    function getGistRootReplacedAt(bytes2, uint256) external pure returns (uint256) {
        return 0;
    }
}
