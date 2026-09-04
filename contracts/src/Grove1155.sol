// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { AccessControlDefaultAdminRules } from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import { IERC5313 } from "@openzeppelin/contracts/interfaces/IERC5313.sol";
import { ERC2981 } from "@openzeppelin/contracts/token/common/ERC2981.sol";
import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { ERC1155Supply } from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import { ERC1155URIStorage } from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155URIStorage.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Grove1155
/// @notice Immutable work records, hard edition caps, and inventory-safe issuance for curated editions.
/// @dev The full approved edition is minted to custody before sale. Pausing stops issuance only.
contract Grove1155 is ERC1155Supply, ERC1155URIStorage, ERC2981, AccessControlDefaultAdminRules, Pausable {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    address public immutable inventorySafe;
    string private collectionMetadataUri;
    mapping(uint256 tokenId => uint256 supplyCap) public maxSupply;
    mapping(uint256 tokenId => bytes32 workId) public workIdByToken;
    mapping(bytes32 workId => uint256 tokenId) public tokenIdByWork;
    mapping(bytes32 workId => bool registered) public registeredWork;
    mapping(bytes32 issuanceId => bool processed) public processedIssuances;

    event WorkConfigured(
        bytes32 indexed workId,
        uint256 indexed tokenId,
        uint256 maxSupply,
        string tokenUri,
        address indexed royaltyReceiver,
        uint96 royaltyFeeNumerator
    );
    event ApprovedEditionMinted(
        bytes32 indexed issuanceId,
        bytes32 indexed workId,
        uint256 indexed tokenId,
        address inventorySafe,
        uint256 quantity
    );
    event ContractURIUpdated();

    error InvalidAddress();
    error InvalidIssuance();
    error InvalidWorkId();
    error InvalidQuantity();
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
        string memory contractUri_
    ) ERC1155("") AccessControlDefaultAdminRules(2 days, admin) {
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

    /// @notice Permanently records an edition's metadata, cap, and royalty signal before sale.
    function configure(
        bytes32 workId,
        uint256 tokenId,
        uint256 supplyCap,
        string calldata tokenUri,
        address royaltyReceiver,
        uint96 royaltyFeeNumerator
    ) external onlyRole(REGISTRAR_ROLE) {
        if (workId == bytes32(0)) revert InvalidWorkId();
        if (royaltyReceiver == address(0)) revert InvalidAddress();
        if (supplyCap == 0) revert InvalidQuantity();
        if (!_isIpfsUri(tokenUri)) revert InvalidTokenURI();
        if (maxSupply[tokenId] != 0 || registeredWork[workId]) revert WorkAlreadyConfigured();
        maxSupply[tokenId] = supplyCap;
        workIdByToken[tokenId] = workId;
        tokenIdByWork[workId] = tokenId;
        registeredWork[workId] = true;
        _setURI(tokenId, tokenUri);
        _setTokenRoyalty(tokenId, royaltyReceiver, royaltyFeeNumerator);
        emit WorkConfigured(workId, tokenId, supplyCap, tokenUri, royaltyReceiver, royaltyFeeNumerator);
    }

    /// @notice Mints the full approved edition to the immutable inventory Safe before bidding starts.
    function mintApprovedEdition(bytes32 issuanceId, uint256 tokenId) external onlyRole(MINTER_ROLE) whenNotPaused {
        if (issuanceId == bytes32(0)) revert InvalidIssuance();
        if (processedIssuances[issuanceId]) revert IssuanceAlreadyProcessed();
        if (maxSupply[tokenId] == 0) revert WorkNotConfigured();
        if (totalSupply(tokenId) != 0) revert WorkAlreadyMinted();

        uint256 quantity = maxSupply[tokenId];
        processedIssuances[issuanceId] = true;
        _mint(inventorySafe, tokenId, quantity, "");
        emit ApprovedEditionMinted(issuanceId, workIdByToken[tokenId], tokenId, inventorySafe, quantity);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function uri(uint256 tokenId) public view override(ERC1155, ERC1155URIStorage) returns (string memory) {
        return super.uri(tokenId);
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
        override(ERC1155, ERC2981, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == type(IERC5313).interfaceId || super.supportsInterface(interfaceId);
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override(ERC1155, ERC1155Supply)
    {
        super._update(from, to, ids, values);
    }
}
