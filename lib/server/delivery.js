import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import { verifyFinalizedInventoryCustody } from "./chain.js";
import { attestSmartAccountProfile } from "./wallet.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ERC721_RECEIVER_INTERFACE = "0x150b7a02";
const ERC1155_RECEIVER_INTERFACE = "0x4e2312e0";

const SAFE_ABI = parseAbi([
  "function masterCopy() view returns (address)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)"
]);
const ERC165_ABI = parseAbi(["function supportsInterface(bytes4 interfaceId) view returns (bool)"]);
const ERC721_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function safeTransferFrom(address from,address to,uint256 tokenId)"
]);
const ERC1155_ABI = parseAbi([
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "function safeTransferFrom(address from,address to,uint256 id,uint256 amount,bytes data)"
]);
const SAFE_SUCCESS_EVENT = parseAbiItem("event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)");
const ERC721_TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)");
const ERC1155_TRANSFER_EVENT = parseAbiItem("event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)");

const sameAddress = (left, right) => getAddress(left) === getAddress(right);
const lower = (value) => value.toLowerCase();

export const createDeliveryClient = (config) => createPublicClient({
  chain: config.wallet.chainId === 1 ? mainnet : sepolia,
  transport: http(config.wallet.rpcUrl)
});

export const buildTokenDeliveryCall = ({ standard, collectionAddress, inventorySafe, winnerSafe, tokenId, quantity }) => {
  const args = [getAddress(inventorySafe), getAddress(winnerSafe), BigInt(tokenId)];
  if (standard === "ERC721") {
    if (BigInt(quantity) !== 1n) throw new Error("ERC721_QUANTITY_INVALID");
    return {
      to: getAddress(collectionAddress),
      data: encodeFunctionData({ abi: ERC721_ABI, functionName: "safeTransferFrom", args })
    };
  }
  if (standard === "ERC1155") {
    if (BigInt(quantity) <= 0n) throw new Error("ERC1155_QUANTITY_INVALID");
    return {
      to: getAddress(collectionAddress),
      data: encodeFunctionData({
        abi: ERC1155_ABI,
        functionName: "safeTransferFrom",
        args: [...args, BigInt(quantity), "0x"]
      })
    };
  }
  throw new Error("NFT_STANDARD_UNSUPPORTED");
};

export const safeTransactionFields = ({ call, nonce }) => ({
  to: call.to,
  value: 0n,
  data: call.data,
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO_ADDRESS,
  refundReceiver: ZERO_ADDRESS,
  nonce: BigInt(nonce)
});

const safeHashArgs = (transaction) => [
  transaction.to,
  transaction.value,
  transaction.data,
  transaction.operation,
  transaction.safeTxGas,
  transaction.baseGas,
  transaction.gasPrice,
  transaction.gasToken,
  transaction.refundReceiver,
  transaction.nonce
];

export const prepareSafeDelivery = async ({ config, settlement, auction, work, collection, account, credentials, client = createDeliveryClient(config) }) => {
  if (settlement.state !== "release-ready" || !settlement.release_authorization_key
      || !settlement.release_evidence_hash || !settlement.release_authorized_at) {
    throw new Error("SETTLEMENT_NOT_RELEASE_READY");
  }
  if (auction.winner_bid_id !== settlement.winning_bid_id) {
    throw new Error("DELIVERY_BINDING_MISMATCH");
  }
  await attestSmartAccountProfile({ config, account, credentials });
  const inventoryProof = await verifyFinalizedInventoryCustody({ config, work, collection, quantity: auction.quantity });
  const [latestBlock, finalizedBlock] = await Promise.all([
    client.getBlock({ blockTag: "latest" }),
    client.getBlock({ blockTag: "finalized" })
  ]);
  if (!finalizedBlock.hash || finalizedBlock.number !== inventoryProof.blockNumber
      || lower(finalizedBlock.hash) !== lower(inventoryProof.blockHash)
      || BigInt(account.deployment_block) > finalizedBlock.number) {
    throw new Error("DELIVERY_FINALITY_MISMATCH");
  }

  const inventorySafe = getAddress(collection.inventory_safe);
  const winnerSafe = getAddress(account.account_address);
  const interfaceId = collection.standard === "ERC721" ? ERC721_RECEIVER_INTERFACE : ERC1155_RECEIVER_INTERFACE;
  const [inventoryCode, inventorySingletonCode, winnerCode, singleton, owners, threshold, finalizedNonce, latestNonce, receiverSupported] = await Promise.all([
    client.getBytecode({ address: inventorySafe, blockNumber: finalizedBlock.number }),
    client.getBytecode({ address: getAddress(config.auctions.inventorySafeSingletonAddress), blockNumber: finalizedBlock.number }),
    client.getBytecode({ address: winnerSafe, blockNumber: finalizedBlock.number }),
    client.readContract({ address: inventorySafe, abi: SAFE_ABI, functionName: "masterCopy", blockNumber: finalizedBlock.number }),
    client.readContract({ address: inventorySafe, abi: SAFE_ABI, functionName: "getOwners", blockNumber: finalizedBlock.number }),
    client.readContract({ address: inventorySafe, abi: SAFE_ABI, functionName: "getThreshold", blockNumber: finalizedBlock.number }),
    client.readContract({ address: inventorySafe, abi: SAFE_ABI, functionName: "nonce", blockNumber: finalizedBlock.number }),
    client.readContract({ address: inventorySafe, abi: SAFE_ABI, functionName: "nonce", blockNumber: latestBlock.number }),
    client.readContract({ address: winnerSafe, abi: ERC165_ABI, functionName: "supportsInterface", args: [interfaceId], blockNumber: finalizedBlock.number })
  ]);
  if (!inventoryCode || keccak256(inventoryCode) !== config.wallet.safeProxyCodeHash
      || !inventorySingletonCode || keccak256(inventorySingletonCode) !== config.auctions.inventorySafeSingletonCodeHash
      || !winnerCode || keccak256(winnerCode) !== config.wallet.safeProxyCodeHash
      || !sameAddress(singleton, config.auctions.inventorySafeSingletonAddress)
      || owners.length !== 3 || threshold !== 2n || finalizedNonce !== latestNonce || !receiverSupported) {
    throw new Error("DELIVERY_SAFE_PROFILE_MISMATCH");
  }

  const call = buildTokenDeliveryCall({
    standard: collection.standard,
    collectionAddress: collection.contract_address,
    inventorySafe,
    winnerSafe,
    tokenId: work.nft_token_id,
    quantity: auction.quantity
  });
  await client.call({ account: inventorySafe, to: call.to, data: call.data, blockNumber: latestBlock.number });
  const transaction = safeTransactionFields({ call, nonce: latestNonce });
  const safeTransactionHash = await client.readContract({
    address: inventorySafe,
    abi: SAFE_ABI,
    functionName: "getTransactionHash",
    args: safeHashArgs(transaction),
    blockNumber: latestBlock.number
  });
  return {
    transaction,
    claim: {
      settlement_uuid: settlement.id,
      expected_chain_id: Number(collection.chain_id),
      expected_standard: collection.standard,
      expected_collection_address: lower(call.to),
      expected_token_id: String(work.nft_token_id),
      expected_quantity: String(auction.quantity),
      expected_from_address: lower(inventorySafe),
      expected_to_address: lower(winnerSafe),
      expected_safe_nonce: String(latestNonce),
      expected_safe_transaction_hash: lower(safeTransactionHash),
      expected_call_data_hash: lower(keccak256(call.data)),
      evidence_block_number: Number(finalizedBlock.number),
      evidence_block_hash: lower(finalizedBlock.hash)
    }
  };
};

const exactTokenTransferObserved = (receipt, delivery) => receipt.logs.some((log) => {
  if (!sameAddress(log.address, delivery.collection_address)) return false;
  try {
    const decoded = decodeEventLog({
      abi: [delivery.standard === "ERC721" ? ERC721_TRANSFER_EVENT : ERC1155_TRANSFER_EVENT],
      data: log.data,
      topics: log.topics,
      strict: true
    });
    if (delivery.standard === "ERC721") return sameAddress(decoded.args.from, delivery.from_address)
      && sameAddress(decoded.args.to, delivery.to_address) && decoded.args.tokenId === BigInt(delivery.token_id);
    return sameAddress(decoded.args.operator, delivery.from_address)
      && sameAddress(decoded.args.from, delivery.from_address) && sameAddress(decoded.args.to, delivery.to_address)
      && decoded.args.id === BigInt(delivery.token_id) && decoded.args.value === BigInt(delivery.quantity);
  } catch {
    return false;
  }
});

export const reconcileSafeDelivery = async ({ config, delivery, client = createDeliveryClient(config) }) => {
  const logs = await client.getLogs({
    address: getAddress(delivery.from_address),
    event: SAFE_SUCCESS_EVENT,
    args: { txHash: delivery.safe_transaction_hash },
    fromBlock: BigInt(delivery.prepared_block_number),
    toBlock: "latest"
  });
  if (logs.length === 0) return { state: "pending" };
  if (logs.length !== 1 || logs[0].args.payment !== 0n) throw new Error("SAFE_EXECUTION_EVIDENCE_INVALID");
  const safeLog = logs[0];
  const [receipt, outerTransaction, finalizedBlock] = await Promise.all([
    client.getTransactionReceipt({ hash: safeLog.transactionHash }),
    client.getTransaction({ hash: safeLog.transactionHash }),
    client.getBlock({ blockTag: "finalized" })
  ]);
  if (receipt.status !== "success" || !outerTransaction.to || !sameAddress(outerTransaction.to, delivery.from_address)
      || lower(receipt.blockHash) !== lower(safeLog.blockHash) || !exactTokenTransferObserved(receipt, delivery)) {
    throw new Error("DELIVERY_RECEIPT_INVALID");
  }
  const execution = decodeFunctionData({ abi: SAFE_ABI, data: outerTransaction.input });
  if (execution.functionName !== "execTransaction") throw new Error("SAFE_EXECUTION_CALL_MISMATCH");
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver] = execution.args;
  const observed = safeTransactionFields({ call: { to, data }, nonce: delivery.safe_nonce });
  if (value !== 0n || operation !== 0 || safeTxGas !== 0n
      || baseGas !== 0n || gasPrice !== 0n || !sameAddress(gasToken, ZERO_ADDRESS)
      || !sameAddress(refundReceiver, ZERO_ADDRESS) || lower(keccak256(data)) !== lower(delivery.call_data_hash)
      || !sameAddress(to, delivery.collection_address)) {
    throw new Error("SAFE_EXECUTION_CALL_MISMATCH");
  }
  const observedHash = await client.readContract({
    address: getAddress(delivery.from_address),
    abi: SAFE_ABI,
    functionName: "getTransactionHash",
    args: safeHashArgs(observed),
    blockNumber: receipt.blockNumber
  });
  if (lower(observedHash) !== lower(delivery.safe_transaction_hash)) throw new Error("SAFE_TRANSACTION_HASH_MISMATCH");

  const inclusion = {
    settlement_uuid: delivery.settlement_id,
    expected_safe_transaction_hash: lower(delivery.safe_transaction_hash),
    execution_transaction_hash: lower(receipt.transactionHash),
    execution_block_number: Number(receipt.blockNumber),
    execution_block_hash: lower(receipt.blockHash),
    execution_log_index: Number(safeLog.logIndex)
  };
  if (!finalizedBlock.hash || finalizedBlock.number < receipt.blockNumber) return { state: "included", inclusion };
  const canonicalBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!canonicalBlock.hash || lower(canonicalBlock.hash) !== lower(receipt.blockHash)) throw new Error("DELIVERY_REORGED");
  return {
    state: "finalized",
    inclusion,
    finalization: {
      settlement_uuid: delivery.settlement_id,
      expected_safe_transaction_hash: lower(delivery.safe_transaction_hash),
      execution_transaction_hash: lower(receipt.transactionHash),
      execution_block_number: Number(receipt.blockNumber),
      execution_block_hash: lower(receipt.blockHash),
      finalized_head_number: Number(finalizedBlock.number),
      finalized_head_hash: lower(finalizedBlock.hash)
    }
  };
};
