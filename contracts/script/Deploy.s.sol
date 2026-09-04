// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script } from "forge-std/Script.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { Grove721 } from "../src/Grove721.sol";
import { Grove1155 } from "../src/Grove1155.sol";

interface ISafeConfiguration {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function masterCopy() external view returns (address);
    function VERSION() external view returns (string memory);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

contract Deploy is Script {
    uint256 private constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    function run() external returns (Grove721 oneOfOnes, Grove1155 editions) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address adminSafe = vm.envAddress("GROVE_ADMIN_SAFE");
        address registrar = vm.envAddress("GROVE_REGISTRAR");
        address minter = vm.envAddress("GROVE_MINTER");
        address pauseGuardian = vm.envAddress("GROVE_PAUSE_GUARDIAN");
        address inventorySafe = vm.envAddress("GROVE_INVENTORY_SAFE");
        uint256 expectedChainId = vm.envUint("GROVE_EXPECTED_CHAIN_ID");
        string memory collectionMetadataUri = vm.envString("GROVE_COLLECTION_METADATA_URI");

        require(expectedChainId == 1 || expectedChainId == 11155111, "unsupported Ethereum network");
        require(block.chainid == expectedChainId, "unexpected chain");
        _validateSafes(adminSafe, inventorySafe);
        require(adminSafe != inventorySafe, "admin and inventory Safes not separated");
        require(
            adminSafe != registrar && adminSafe != minter && adminSafe != pauseGuardian && inventorySafe != registrar
                && inventorySafe != minter && inventorySafe != pauseGuardian,
            "Safe and operational roles not separated"
        );
        require(
            registrar != minter && registrar != pauseGuardian && minter != pauseGuardian,
            "operational roles not separated"
        );

        vm.startBroadcast(deployerKey);
        oneOfOnes = new Grove721(
            adminSafe,
            registrar,
            minter,
            pauseGuardian,
            inventorySafe,
            "Grove One of Ones",
            "GROVE",
            collectionMetadataUri
        );
        editions = new Grove1155(adminSafe, registrar, minter, pauseGuardian, inventorySafe, collectionMetadataUri);
        vm.stopBroadcast();

        require(oneOfOnes.hasRole(oneOfOnes.REGISTRAR_ROLE(), registrar), "721 registrar mismatch");
        require(oneOfOnes.hasRole(oneOfOnes.MINTER_ROLE(), minter), "721 minter mismatch");
        require(oneOfOnes.hasRole(oneOfOnes.PAUSER_ROLE(), pauseGuardian), "721 guardian mismatch");
        require(editions.hasRole(editions.REGISTRAR_ROLE(), registrar), "1155 registrar mismatch");
        require(editions.hasRole(editions.MINTER_ROLE(), minter), "1155 minter mismatch");
        require(editions.hasRole(editions.PAUSER_ROLE(), pauseGuardian), "1155 guardian mismatch");
        require(oneOfOnes.inventorySafe() == inventorySafe, "721 inventory mismatch");
        require(editions.inventorySafe() == inventorySafe, "1155 inventory mismatch");
    }

    function _validateSafes(address adminSafe, address inventorySafe) internal view {
        address expectedSafeSingleton = vm.envAddress("GROVE_SAFE_SINGLETON");
        bytes32 expectedSafeProxyCodeHash = vm.envBytes32("GROVE_SAFE_PROXY_CODE_HASH");
        bytes32 expectedSafeSingletonCodeHash = vm.envBytes32("GROVE_SAFE_SINGLETON_CODE_HASH");
        address expectedSafeFallbackHandler = vm.envAddress("GROVE_SAFE_FALLBACK_HANDLER");
        bytes32 expectedSafeFallbackHandlerCodeHash = vm.envBytes32("GROVE_SAFE_FALLBACK_HANDLER_CODE_HASH");
        string memory expectedSafeVersion = vm.envString("GROVE_SAFE_VERSION");

        require(adminSafe.code.length > 0, "admin Safe has no code");
        require(inventorySafe.code.length > 0, "inventory Safe has no code");
        require(adminSafe.codehash == expectedSafeProxyCodeHash, "admin Safe proxy code hash mismatch");
        require(inventorySafe.codehash == expectedSafeProxyCodeHash, "inventory Safe proxy code hash mismatch");
        require(expectedSafeSingleton.codehash == expectedSafeSingletonCodeHash, "Safe singleton code hash mismatch");
        require(
            expectedSafeFallbackHandler.codehash == expectedSafeFallbackHandlerCodeHash,
            "Safe fallback handler code hash mismatch"
        );
        require(ISafeConfiguration(adminSafe).masterCopy() == expectedSafeSingleton, "admin Safe singleton mismatch");
        require(
            ISafeConfiguration(inventorySafe).masterCopy() == expectedSafeSingleton, "inventory Safe singleton mismatch"
        );
        require(
            keccak256(bytes(ISafeConfiguration(adminSafe).VERSION())) == keccak256(bytes(expectedSafeVersion)),
            "admin Safe version mismatch"
        );
        require(
            keccak256(bytes(ISafeConfiguration(inventorySafe).VERSION())) == keccak256(bytes(expectedSafeVersion)),
            "inventory Safe version mismatch"
        );
        require(
            _fallbackHandler(inventorySafe) == expectedSafeFallbackHandler, "inventory Safe fallback handler mismatch"
        );
        require(
            IERC165(inventorySafe).supportsInterface(type(IERC721Receiver).interfaceId),
            "inventory Safe cannot receive ERC721"
        );
        require(
            IERC165(inventorySafe).supportsInterface(type(IERC1155Receiver).interfaceId),
            "inventory Safe cannot receive ERC1155"
        );
        require(ISafeConfiguration(adminSafe).getOwners().length == 3, "admin Safe must have 3 owners");
        require(ISafeConfiguration(adminSafe).getThreshold() == 2, "admin Safe must require 2 owners");
        require(ISafeConfiguration(inventorySafe).getOwners().length == 3, "inventory Safe must have 3 owners");
        require(ISafeConfiguration(inventorySafe).getThreshold() == 2, "inventory Safe must require 2 owners");
    }

    function _fallbackHandler(address safe) internal view returns (address) {
        bytes memory value = ISafeConfiguration(safe).getStorageAt(FALLBACK_HANDLER_STORAGE_SLOT, 1);
        require(value.length == 32, "invalid fallback handler storage");
        bytes32 word;
        assembly ("memory-safe") {
            word := mload(add(value, 0x20))
        }
        return address(uint160(uint256(word)));
    }
}
