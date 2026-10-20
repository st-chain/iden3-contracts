// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.27;

/**
 * @dev Simulates an unexpected requestID lookup failure, not an absent input.
 */
contract RequestIDLookupFailureStub {
    function inputIndexOf(string memory) external pure returns (uint256) {
        revert("requestID lookup failed");
    }
}
