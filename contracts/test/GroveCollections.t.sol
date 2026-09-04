// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import { Grove721 } from "../src/Grove721.sol";
import { Grove1155 } from "../src/Grove1155.sol";

contract GroveCollectionsTest is Test {
    Grove721 internal oneOfOnes;
    Grove1155 internal editions;

    address internal collector = makeAddr("collector");
    address internal secondCollector = makeAddr("second-collector");
    address internal artist = makeAddr("artist");
    address internal attacker = makeAddr("attacker");
    address internal registrar = makeAddr("registrar");
    address internal minter = makeAddr("minter");
    address internal pauseGuardian = makeAddr("pause-guardian");
    address internal inventorySafe;
    string internal constant COLLECTION_URI = "ipfs://grove/collection.json";

    function setUp() public {
        inventorySafe = makeAddr("inventory-safe");
        oneOfOnes = new Grove721(
            address(this), registrar, minter, pauseGuardian, inventorySafe, "Grove One of Ones", "GROVE", COLLECTION_URI
        );
        editions = new Grove1155(address(this), registrar, minter, pauseGuardian, inventorySafe, COLLECTION_URI);
    }

    function workId(uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(abi.encode("grove-work", tokenId));
    }

    function configure721(uint256 tokenId, string memory tokenUri, uint96 royalty) internal {
        vm.prank(registrar);
        oneOfOnes.configure(workId(tokenId), tokenId, tokenUri, artist, royalty);
    }

    function mint721(bytes32 issuanceId, uint256 tokenId) internal {
        vm.prank(minter);
        oneOfOnes.mintApprovedWork(issuanceId, tokenId);
    }

    function configure1155(uint256 tokenId, uint256 cap, string memory tokenUri, uint96 royalty) internal {
        vm.prank(registrar);
        editions.configure(workId(tokenId), tokenId, cap, tokenUri, artist, royalty);
    }

    function mint1155(bytes32 issuanceId, uint256 tokenId) internal {
        vm.prank(minter);
        editions.mintApprovedEdition(issuanceId, tokenId);
    }

    function testOneOfOneConfigurationAndOrderAreImmutable() public {
        configure721(101, "ipfs://work/101.json", 1_000);
        bytes32 issuanceId = keccak256("issuance-1");
        mint721(issuanceId, 101);

        assertEq(oneOfOnes.ownerOf(101), inventorySafe);
        assertEq(oneOfOnes.workIdOf(101), workId(101));
        assertEq(oneOfOnes.tokenIdByWork(workId(101)), 101);
        assertEq(oneOfOnes.tokenURI(101), "ipfs://work/101.json");
        (address receiver, uint256 amount) = oneOfOnes.royaltyInfo(101, 1_000e6);
        assertEq(receiver, artist);
        assertEq(amount, 100e6);

        vm.expectRevert(Grove721.WorkAlreadyConfigured.selector);
        configure721(101, "ipfs://changed", 0);
        vm.expectRevert(Grove721.IssuanceAlreadyProcessed.selector);
        mint721(issuanceId, 102);
    }

    function testOnlyAuthorizedRolesCanConfigureMintPauseOrUnpause() public {
        vm.startPrank(attacker);
        vm.expectRevert();
        oneOfOnes.configure(workId(1), 1, "ipfs://work/1", artist, 0);
        vm.expectRevert();
        oneOfOnes.mintApprovedWork(keccak256("issuance"), 1);
        vm.expectRevert();
        oneOfOnes.pause();
        vm.expectRevert();
        oneOfOnes.unpause();
        vm.stopPrank();
    }

    function testPauseBlocksMintButNeverCollectorTransfer() public {
        configure721(1, "ipfs://work/1", 0);
        mint721(keccak256("issuance-1"), 1);
        vm.prank(inventorySafe);
        oneOfOnes.transferFrom(inventorySafe, collector, 1);
        configure721(2, "ipfs://work/2", 0);
        vm.prank(pauseGuardian);
        oneOfOnes.pause();

        vm.expectRevert();
        mint721(keccak256("issuance-2"), 2);
        vm.prank(collector);
        oneOfOnes.transferFrom(collector, secondCollector, 1);
        assertEq(oneOfOnes.ownerOf(1), secondCollector);
    }

    function testFullEditionIsMintedToInventoryOnce() public {
        configure1155(7, 5, "ipfs://work/7.json", 750);
        assertEq(editions.uri(7), "ipfs://work/7.json");
        (address receiver, uint256 amount) = editions.royaltyInfo(7, 10_000);
        assertEq(receiver, artist);
        assertEq(amount, 750);
        bytes32 issuanceId = keccak256("issuance-a");
        mint1155(issuanceId, 7);
        assertEq(editions.totalSupply(7), 5);
        assertEq(editions.balanceOf(inventorySafe, 7), 5);
        assertEq(editions.workIdByToken(7), workId(7));

        vm.expectRevert(Grove1155.WorkAlreadyMinted.selector);
        mint1155(keccak256("issuance-b"), 7);
        vm.expectRevert(Grove1155.IssuanceAlreadyProcessed.selector);
        mint1155(issuanceId, 8);
    }

    function testMetadataMustUseContentAddressedScheme() public {
        vm.expectRevert(Grove721.InvalidTokenURI.selector);
        configure721(1, "https://mutable.example/work.json", 500);
        vm.expectRevert(Grove1155.InvalidTokenURI.selector);
        configure1155(1, 1, "", 500);
    }

    function testEditionTransfersRemainLiveWhileMintingIsPaused() public {
        configure1155(8, 2, "ipfs://work/8.json", 750);
        mint1155(keccak256("issuance-a"), 8);
        vm.prank(inventorySafe);
        editions.safeTransferFrom(inventorySafe, collector, 8, 2, "");
        vm.prank(pauseGuardian);
        editions.pause();

        vm.expectRevert();
        mint1155(keccak256("issuance-b"), 8);
        vm.prank(collector);
        editions.safeTransferFrom(collector, secondCollector, 8, 1, "");
        assertEq(editions.balanceOf(secondCollector, 8), 1);
    }

    function testStandardsAreAdvertised() public view {
        assertTrue(oneOfOnes.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(editions.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(oneOfOnes.supportsInterface(0x8da5cb5b));
        assertTrue(editions.supportsInterface(0x8da5cb5b));
        assertFalse(oneOfOnes.supportsInterface(0x7f5828d0));
        assertFalse(editions.supportsInterface(0x7f5828d0));
        assertEq(oneOfOnes.contractURI(), COLLECTION_URI);
        assertEq(editions.contractURI(), COLLECTION_URI);
        assertEq(oneOfOnes.owner(), address(this));
        assertEq(editions.owner(), address(this));
    }

    function testFuzzEditionSupplyEqualsConfiguredCap(uint32 rawCap) public {
        uint256 cap = bound(rawCap, 1, 1_000_000);
        configure1155(99, cap, "ipfs://work/99.json", 500);
        mint1155(keccak256("fuzz-issuance-a"), 99);
        assertEq(editions.totalSupply(99), cap);
        assertEq(editions.balanceOf(inventorySafe, 99), cap);
    }

    function testFuzzIssuanceIdMintsAtMostOnce(bytes32 issuanceId) public {
        vm.assume(issuanceId != bytes32(0));
        configure721(77, "ipfs://work/77.json", 500);
        mint721(issuanceId, 77);
        vm.expectRevert(Grove721.IssuanceAlreadyProcessed.selector);
        mint721(issuanceId, 77);
        assertEq(oneOfOnes.ownerOf(77), inventorySafe);
    }

    function testWorkIdentifiersAreUniqueAcrossTokenIds() public {
        configure721(1, "ipfs://work/1.json", 0);
        vm.prank(registrar);
        vm.expectRevert(Grove721.WorkAlreadyConfigured.selector);
        oneOfOnes.configure(workId(1), 2, "ipfs://work/2.json", artist, 0);

        configure1155(3, 2, "ipfs://work/3.json", 0);
        vm.prank(registrar);
        vm.expectRevert(Grove1155.WorkAlreadyConfigured.selector);
        editions.configure(workId(3), 4, 2, "ipfs://work/4.json", artist, 0);
    }

    function testOperationalRolesAreSeparated() public view {
        assertTrue(oneOfOnes.hasRole(oneOfOnes.DEFAULT_ADMIN_ROLE(), address(this)));
        assertFalse(oneOfOnes.hasRole(oneOfOnes.REGISTRAR_ROLE(), address(this)));
        assertTrue(oneOfOnes.hasRole(oneOfOnes.REGISTRAR_ROLE(), registrar));
        assertFalse(oneOfOnes.hasRole(oneOfOnes.MINTER_ROLE(), registrar));
        assertTrue(oneOfOnes.hasRole(oneOfOnes.MINTER_ROLE(), minter));
        assertFalse(oneOfOnes.hasRole(oneOfOnes.PAUSER_ROLE(), minter));
        assertTrue(oneOfOnes.hasRole(oneOfOnes.PAUSER_ROLE(), pauseGuardian));
    }
}
