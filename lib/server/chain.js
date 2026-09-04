import { createPublicClient, getAddress, http, keccak256 } from "viem";
import { mainnet, sepolia } from "viem/chains";

const ERC721_OWNER_OF_ABI = [{
  type: "function",
  name: "ownerOf",
  stateMutability: "view",
  inputs: [{ name: "tokenId", type: "uint256" }],
  outputs: [{ name: "owner", type: "address" }]
}];

const ERC1155_BALANCE_OF_ABI = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }, { name: "id", type: "uint256" }],
  outputs: [{ name: "balance", type: "uint256" }]
}];

const publicClient = (config) => createPublicClient({
  chain: config.wallet.chainId === 1 ? mainnet : sepolia,
  transport: http(config.wallet.rpcUrl)
});

export const verifyFinalizedInventoryCustody = async ({ config, work, collection, quantity }) => {
  if (Number(collection.chain_id) !== config.wallet.chainId) throw new Error("COLLECTION_CHAIN_MISMATCH");
  const client = publicClient(config);
  const block = await client.getBlock({ blockTag: "finalized" });
  if (!block.hash || BigInt(collection.deployment_block) > block.number || BigInt(work.nft_mint_block) > block.number) {
    throw new Error("NFT_NOT_FINALIZED");
  }
  const bytecode = await client.getBytecode({ address: collection.contract_address, blockNumber: block.number });
  if (!bytecode || keccak256(bytecode).toLowerCase() !== collection.deployed_code_hash.toLowerCase()) {
    throw new Error("COLLECTION_CODE_HASH_MISMATCH");
  }

  const tokenId = BigInt(work.nft_token_id);
  const requiredQuantity = BigInt(quantity);
  if (collection.standard === "ERC721") {
    if (requiredQuantity !== 1n) throw new Error("ERC721_QUANTITY_INVALID");
    const owner = await client.readContract({
      address: collection.contract_address,
      abi: ERC721_OWNER_OF_ABI,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: block.number
    });
    if (getAddress(owner) !== getAddress(collection.inventory_safe)) throw new Error("NFT_NOT_IN_INVENTORY_SAFE");
  } else if (collection.standard === "ERC1155") {
    const balance = await client.readContract({
      address: collection.contract_address,
      abi: ERC1155_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [collection.inventory_safe, tokenId],
      blockNumber: block.number
    });
    if (balance < requiredQuantity) throw new Error("NFT_INVENTORY_BALANCE_LOW");
  } else {
    throw new Error("NFT_STANDARD_UNSUPPORTED");
  }

  return { blockNumber: block.number, blockHash: block.hash };
};
