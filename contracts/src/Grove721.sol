// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { AccessControlDefaultAdminRules } from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import { IERC5313 } from "@openzeppelin/contracts/interfaces/IERC5313.sol";
import { ERC2981 } from "@openzeppelin/contracts/token/common/ERC2981.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Grove721
/// @notice Immutable work records and inventory-safe issuance for curated one-of-one works.
/// @dev Every approved work is minted to custody before its auction opens. Pausing stops issuance only.
contract Grove721 is ERC721, ERC2981, AccessControlDefaultAdminRules, Pausable {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Work {
        bytes32 workId;
        string tokenUri;
        bool configured;
        bool minted;
    }

    address public immutable inventorySafe;
    string private collectionMetadataUri;
    mapping(uint256 tokenId => Work work) private works;
    mapping(bytes32 workId => uint256 tokenId) public tokenIdByWork;
    mapping(bytes32 workId => bool registered) public registeredWork;
    mapping(bytes32 issuanceId => bool processed) public processedIssuances;

    event WorkConfigured(
        bytes32 indexed workId,
        uint256 indexed tokenId,
        string tokenUri,
        address indexed royaltyReceiver,
        uint96 royaltyFeeNumerator
    );
    event ApprovedWorkMinted(
        bytes32 indexed issuanceId, bytes32 indexed workId, uint256 indexed tokenId, address inventorySafe
    );
    event ContractURIUpdated();

    error InvalidAddress();
    error InvalidIssuance();
    error InvalidWorkId();
    error InvalidTokenURI();
    error WorkAlreadyConfigured();
    error WorkNotConfigured();
    error WorkAlreadyMinted();
    error IssuanceAlreadyProcessed();

    constructor(
        address admin,
        address registrar,
        address minter,
        address pauseGuardian,
        address inventorySafe_,
        string memory name_,
        string memory symbol_,
        string memory contractUri_
    ) ERC721(name_, symbol_) AccessControlDefaultAdminRules(2 days, admin) {
        if (
            admin == address(0) || registrar == address(0) || minter == address(0) || pauseGuardian == address(0)
                || inventorySafe_ == address(0)
        ) {
            revert InvalidAddress();
        }
        if (!_isIpfsUri(contractUri_)) revert InvalidTokenURI();
        inventorySafe = inventorySafe_;
        collectionMetadataUri = contractUri_;
        _grantRole(REGISTRAR_ROLE, registrar);
        _grantRole(MINTER_ROLE, minter);
        _grantRole(PAUSER_ROLE, pauseGuardian);
    }

    /// @notice Permanently records a work's metadata and royalty signal before sale.
    function configure(
        bytes32 workId,
        uint256 tokenId,
        string calldata tokenUri,
        address royaltyReceiver,
        uint96 royaltyFeeNumerator
    ) external onlyRole(REGISTRAR_ROLE) {
        if (workId == bytes32(0)) revert InvalidWorkId();
        if (royaltyReceiver == address(0)) revert InvalidAddress();
        if (!_isIpfsUri(tokenUri)) revert InvalidTokenURI();
        if (works[tokenId].configured || registeredWork[workId]) revert WorkAlreadyConfigured();
        works[tokenId] = Work({ workId: workId, tokenUri: tokenUri, configured: true, minted: false });
        tokenIdByWork[workId] = tokenId;
        registeredWork[workId] = true;
        _setTokenRoyalty(tokenId, royaltyReceiver, royaltyFeeNumerator);
        emit WorkConfigured(workId, tokenId, tokenUri, royaltyReceiver, royaltyFeeNumerator);
    }

    /// @notice Mints an approved work to the immutable inventory Safe before bidding starts.
    /// @param issuanceId A PII-free, domain-bound issuance identifier from the commerce ledger.
    function mintApprovedWork(bytes32 issuanceId, uint256 tokenId) external onlyRole(MINTER_ROLE) whenNotPaused {
        if (issuanceId == bytes32(0)) revert InvalidIssuance();
        if (processedIssuances[issuanceId]) revert IssuanceAlreadyProcessed();
        Work storage work = works[tokenId];
        if (!work.configured) revert WorkNotConfigured();
        if (work.minted) revert WorkAlreadyMinted();

        processedIssuances[issuanceId] = true;
        work.minted = true;
        _safeMint(inventorySafe, tokenId);
        emit ApprovedWorkMinted(issuanceId, work.workId, tokenId, inventorySafe);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return works[tokenId].tokenUri;
    }

    function isConfigured(uint256 tokenId) external view returns (bool) {
        return works[tokenId].configured;
    }

    function workIdOf(uint256 tokenId) external view returns (bytes32) {
        if (!works[tokenId].configured) revert WorkNotConfigured();
        return works[tokenId].workId;
    }

    /// @notice ERC-7572 collection metadata used by marketplaces such as OpenSea.
    function contractURI() external view returns (string memory) {
        return collectionMetadataUri;
    }

    function _isIpfsUri(string memory value) private pure returns (bool) {
        bytes memory uriBytes = bytes(value);
        return uriBytes.length > 7 && uriBytes[0] == "i" && uriBytes[1] == "p" && uriBytes[2] == "f"
            && uriBytes[3] == "s" && uriBytes[4] == ":" && uriBytes[5] == "/" && uriBytes[6] == "/";
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC2981, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == type(IERC5313).interfaceId || super.supportsInterface(interfaceId);
    }
}
