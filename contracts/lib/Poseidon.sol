// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.27;

/// @dev Ethermint EVM 预编译合约地址 (0x100)
address constant POSEIDON_PRECOMPILE_ADDRESS = address(0x100);

library PoseidonUnit1L {
    function poseidon(uint256[1] memory input) internal view returns (uint256 result) {
        address target = POSEIDON_PRECOMPILE_ADDRESS;
        assembly {
            let outPtr := mload(0x40)
            let success := staticcall(gas(), target, input, 32, outPtr, 32)
            if iszero(success) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            result := mload(outPtr)
        }
    }
}

library PoseidonUnit2L {
    function poseidon(uint256[2] memory input) internal view returns (uint256 result) {
        address target = POSEIDON_PRECOMPILE_ADDRESS;
        assembly {
            let outPtr := mload(0x40)
            let success := staticcall(gas(), target, input, 64, outPtr, 32)
            if iszero(success) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            result := mload(outPtr)
        }
    }
}

library PoseidonUnit3L {
    function poseidon(uint256[3] memory input) internal view returns (uint256 result) {
        address target = POSEIDON_PRECOMPILE_ADDRESS;
        assembly {
            let outPtr := mload(0x40)
            let success := staticcall(gas(), target, input, 96, outPtr, 32)
            if iszero(success) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            result := mload(outPtr)
        }
    }
}

library PoseidonUnit4L {
    function poseidon(uint256[4] memory input) internal view returns (uint256 result) {
        address target = POSEIDON_PRECOMPILE_ADDRESS;
        assembly {
            let outPtr := mload(0x40)
            let success := staticcall(gas(), target, input, 128, outPtr, 32)
            if iszero(success) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            result := mload(outPtr)
        }
    }
}

library PoseidonUnit5L {
    function poseidon(uint256[5] memory input) internal view returns (uint256 result) {
        address target = POSEIDON_PRECOMPILE_ADDRESS;
        assembly {
            let outPtr := mload(0x40)
            let success := staticcall(gas(), target, input, 160, outPtr, 32)
            if iszero(success) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            result := mload(outPtr)
        }
    }
}

library PoseidonUnit6L {
    function poseidon(uint256[6] memory input) internal view returns (uint256 result) {
        address target = POSEIDON_PRECOMPILE_ADDRESS;
        assembly {
            let outPtr := mload(0x40)
            let success := staticcall(gas(), target, input, 192, outPtr, 32)
            if iszero(success) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            result := mload(outPtr)
        }
    }
}

library SpongePoseidon {
    uint32 internal constant BATCH_SIZE = 6;

    function hash(uint256[] memory values) public view returns (uint256) {
        uint256[BATCH_SIZE] memory frame = [uint256(0), 0, 0, 0, 0, 0];
        bool dirty = false;
        uint256 fullHash = 0;
        uint32 k = 0;
        for (uint32 i = 0; i < values.length; i++) {
            dirty = true;
            frame[k] = values[i];
            if (k == BATCH_SIZE - 1) {
                fullHash = PoseidonUnit6L.poseidon(frame);
                dirty = false;
                frame = [uint256(0), 0, 0, 0, 0, 0];
                frame[0] = fullHash;
                k = 1;
            } else {
                k++;
            }
        }
        if (dirty) {
            // we haven't hashed something in the main sponge loop and need to do hash here
            fullHash = PoseidonUnit6L.poseidon(frame);
        }
        return fullHash;
    }
}

library PoseidonFacade {
    function poseidon1(uint256[1] memory el) public view returns (uint256) {
        return PoseidonUnit1L.poseidon(el);
    }

    function poseidon2(uint256[2] memory el) public view returns (uint256) {
        return PoseidonUnit2L.poseidon(el);
    }

    function poseidon3(uint256[3] memory el) public view returns (uint256) {
        return PoseidonUnit3L.poseidon(el);
    }

    function poseidon4(uint256[4] memory el) public view returns (uint256) {
        return PoseidonUnit4L.poseidon(el);
    }

    function poseidon5(uint256[5] memory el) public view returns (uint256) {
        return PoseidonUnit5L.poseidon(el);
    }

    function poseidon6(uint256[6] memory el) public view returns (uint256) {
        return PoseidonUnit6L.poseidon(el);
    }

    function poseidonSponge(uint256[] memory el) public view returns (uint256) {
        return SpongePoseidon.hash(el);
    }
}

/// @dev 通用 Poseidon 预编译合约调用库
library Poseidon {
    function hash(uint256[] memory input) internal view returns (uint256 result) {
        require(input.length >= 1 && input.length <= 16, "Poseidon: input length must be 1 to 16");
        address target = POSEIDON_PRECOMPILE_ADDRESS;
        assembly {
            let len := mul(mload(input), 32)
            let data := add(input, 0x20)
            let outPtr := mload(0x40)
            let success := staticcall(gas(), target, data, len, outPtr, 32)
            if iszero(success) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            result := mload(outPtr)
        }
    }
}
