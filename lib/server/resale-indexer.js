import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  getAddress,
  getEventSelector,
  http,
  keccak256,
  stringToHex
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import { requireSecondaryIndexerConfig } from "./config.js";
import { verifySecondaryInfrastructure } from "./resale.js";

const WORKER_NAME = "resale-finalized-v2";
const DEFAULT_BLOCK_PAGE_SIZE = 1_000n;
const DEFAULT_MAX_BLOCK_PAGES = 5;
const DATABASE_PAGE_SIZE = 500;
const ADDRESS_FILTER_PAGE_SIZE = 50;
const LEASE_SECONDS = 240;
const MAX_EVENTS_PER_BLOCK_PAGE = 2_000;
const UNRESOLVED_ORDER_STATES = ["open", "cancel-requested", "fill-submitted", "included", "reorged", "exception"];

const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  anonymous: false,
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: true, name: "tokenId", type: "uint256" }
  ]
};

const COUNTER_INCREMENTED_EVENT = {
  type: "event",
  name: "CounterIncremented",
  anonymous: false,
  inputs: [
    { indexed: false, name: "newCounter", type: "uint256" },
    { indexed: true, name: "offerer", type: "address" }
  ]
};

const ORDER_CANCELLED_EVENT = {
  type: "event",
  name: "OrderCancelled",
  anonymous: false,
  inputs: [
    { indexed: false, name: "orderHash", type: "bytes32" },
    { indexed: true, name: "offerer", type: "address" },
    { indexed: true, name: "zone", type: "address" }
  ]
};

const ORDER_FULFILLED_EVENT = {
  type: "event",
  name: "OrderFulfilled",
  anonymous: false,
  inputs: [
    { indexed: false, name: "orderHash", type: "bytes32" },
    { indexed: true, name: "offerer", type: "address" },
    { indexed: true, name: "zone", type: "address" },
    { indexed: false, name: "recipient", type: "address" },
    {
      indexed: false,
      name: "offer",
      type: "tuple[]",
      components: [
        { name: "itemType", type: "uint8" },
        { name: "token", type: "address" },
        { name: "identifier", type: "uint256" },
        { name: "amount", type: "uint256" }
      ]
    },
    {
      indexed: false,
      name: "consideration",
      type: "tuple[]",
      components: [
        { name: "itemType", type: "uint8" },
        { name: "token", type: "address" },
        { name: "identifier", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "recipient", type: "address" }
      ]
    }
  ]
};

const EVENT_BY_NAME = new Map([
  ["Transfer", TRANSFER_EVENT],
  ["CounterIncremented", COUNTER_INCREMENTED_EVENT],
  ["OrderCancelled", ORDER_CANCELLED_EVENT],
  ["OrderFulfilled", ORDER_FULFILLED_EVENT]
]);

const clientFor = (config) => createPublicClient({
  chain: config.wallet.chainId === 1 ? mainnet : sepolia,
  transport: http(config.wallet.rpcUrl)
});

const integer = (input, code) => {
  const output = Number(input);
  if (!Number.isSafeInteger(output) || output < 0) throw new Error(code);
  return output;
};

const requiredHex = (input, bytes, code) => {
  const output = String(input || "").toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(output)) throw new Error(code);
  return output;
};

const address = (input) => getAddress(input).toLowerCase();
const uint = (input) => BigInt(input).toString();
const chunks = (items, size) => Array.from(
  { length: Math.ceil(items.length / size) },
  (_, index) => items.slice(index * size, (index + 1) * size)
);

const spentItem = (item) => ({
  item_type: integer(item.itemType, "INVALID_SEAPORT_ITEM"),
  token: address(item.token),
  identifier: uint(item.identifier),
  amount: uint(item.amount)
});

const receivedItem = (item) => ({
  ...spentItem(item),
  recipient: address(item.recipient)
});

const logEvidence = (eventName, log) => {
  const event = EVENT_BY_NAME.get(eventName);
  if (!event || log.removed === true) throw new Error("NON_FINAL_LOG_REJECTED");
  const topic0 = getEventSelector(event).toLowerCase();
  if (log.topics?.[0] && String(log.topics[0]).toLowerCase() !== topic0) throw new Error("EVENT_TOPIC_MISMATCH");
  return {
    event_name: eventName,
    emitter_address: address(log.address),
    topic0,
    transaction_hash: requiredHex(log.transactionHash, 32, "LOG_TRANSACTION_HASH_MISSING"),
    transaction_index: integer(log.transactionIndex, "LOG_TRANSACTION_INDEX_MISSING"),
    log_index: integer(log.logIndex, "LOG_INDEX_MISSING"),
    block_number: uint(log.blockNumber),
    block_hash: requiredHex(log.blockHash, 32, "LOG_BLOCK_HASH_MISSING"),
    removed: false
  };
};

export const normalizeFinalizedResaleLog = (eventName, log) => {
  const base = logEvidence(eventName, log);
  const args = log.args || {};
  let event;
  if (eventName === "Transfer") {
    event = {
      ...base,
      token_id: uint(args.tokenId),
      from_address: address(args.from),
      to_address: address(args.to),
      event_data: {}
    };
  } else if (eventName === "CounterIncremented") {
    event = {
      ...base,
      from_address: address(args.offerer),
      counter: uint(args.newCounter),
      event_data: {}
    };
  } else if (eventName === "OrderCancelled") {
    event = {
      ...base,
      order_hash: requiredHex(args.orderHash, 32, "ORDER_HASH_MISSING"),
      from_address: address(args.offerer),
      event_data: { zone: address(args.zone) }
    };
  } else if (eventName === "OrderFulfilled") {
    event = {
      ...base,
      order_hash: requiredHex(args.orderHash, 32, "ORDER_HASH_MISSING"),
      from_address: address(args.offerer),
      to_address: address(args.recipient),
      event_data: {
        zone: address(args.zone),
        offer: (args.offer || []).map(spentItem),
        consideration: (args.consideration || []).map(receivedItem)
      }
    };
  } else {
    throw new Error("UNSUPPORTED_RESALE_EVENT");
  }
  event.payload_hash = keccak256(stringToHex(JSON.stringify(event)));
  return event;
};

export const finalizedBlockRanges = ({ fromBlock, throughBlock, pageSize = DEFAULT_BLOCK_PAGE_SIZE, maxPages = DEFAULT_MAX_BLOCK_PAGES }) => {
  const from = BigInt(fromBlock);
  const through = BigInt(throughBlock);
  const size = BigInt(pageSize);
  if (from < 0n || through < 0n || size < 1n || !Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error("INVALID_INDEXER_RANGE");
  }
  const ranges = [];
  let cursor = from;
  while (cursor <= through && ranges.length < maxPages) {
    const toBlock = cursor + size - 1n > through ? through : cursor + size - 1n;
    ranges.push({ fromBlock: cursor, toBlock });
    cursor = toBlock + 1n;
  }
  return { ranges, nextBlock: cursor, caughtUp: cursor > through };
};

const resultData = (result, code) => {
  if (result.error) throw Object.assign(new Error(code), { cause: result.error, code });
  return result.data;
};

const loadPaged = async (queryFor, pageSize = DATABASE_PAGE_SIZE) => {
  const output = [];
  for (let offset = 0; ; offset += pageSize) {
    const result = await queryFor(offset, offset + pageSize - 1);
    const page = resultData(result, "INDEXER_DATABASE_PAGE_FAILED") || [];
    output.push(...page);
    if (page.length < pageSize) return output;
  }
};

export const createResaleIndexerRepository = (service) => ({
  async claim({ workerName, chainId, leaseToken }) {
    const result = await service.rpc("claim_resale_indexer_lease", {
      p_worker_name: workerName,
      p_chain_id: chainId,
      p_lease_token: leaseToken,
      p_lease_seconds: LEASE_SECONDS
    });
    return resultData(result, "INDEXER_LEASE_CLAIM_FAILED") === true;
  },

  async latestCheckpoint({ workerName, chainId }) {
    const result = await service.from("chain_indexer_checkpoints")
      .select("id,from_block_number,from_block_hash,through_block_number,through_block_hash,finalized_block_number,finalized_block_hash")
      .eq("worker_name", workerName).eq("chain_id", chainId)
      .order("through_block_number", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    return resultData(result, "INDEXER_CHECKPOINT_READ_FAILED");
  },

  async trackedAssets({ chainId }) {
    const works = await loadPaged((from, to) => service.from("works")
      .select("id,nft_collection_id,nft_token_id")
      .eq("format", "digital").eq("contract_status", "minted")
      .not("nft_collection_id", "is", null).not("nft_token_id", "is", null)
      .order("id", { ascending: true }).range(from, to));
    const collectionIds = new Set(works.map((work) => work.nft_collection_id));
    const collections = await loadPaged((from, to) => service.from("nft_collections")
      .select("id,chain_id,contract_address,deployed_code_hash,state")
      .eq("chain_id", chainId).eq("standard", "ERC721").in("state", ["rehearsal", "active"])
      .order("id", { ascending: true }).range(from, to));
    const eligibleCollections = collections.filter((collection) => collectionIds.has(collection.id));
    const eligibleIds = new Set(eligibleCollections.map((collection) => collection.id));
    return {
      collections: eligibleCollections,
      tokenKeys: new Set(works.filter((work) => eligibleIds.has(work.nft_collection_id))
        .map((work) => `${work.nft_collection_id}:${String(work.nft_token_id)}`)),
      collectionIdByAddress: new Map(eligibleCollections.map((collection) => [collection.contract_address, collection.id]))
    };
  },

  async unresolvedOrders({ chainId }) {
    return loadPaged((from, to) => service.from("resale_orders")
      .select("id,order_hash,seller_address,counter,collection_address,token_id,state")
      .eq("chain_id", chainId).in("state", UNRESOLVED_ORDER_STATES)
      .order("id", { ascending: true }).range(from, to));
  },

  async applyBatch(input) {
    const result = await service.rpc("apply_resale_indexer_batch", input);
    return resultData(result, "INDEXER_BATCH_APPLY_FAILED");
  },

  async expire(input) {
    const result = await service.rpc("expire_resale_orders_at_finalized_head", input);
    return resultData(result, "INDEXER_EXPIRY_FAILED");
  },

  async release({ workerName, chainId, leaseToken }) {
    const result = await service.rpc("release_resale_indexer_lease", {
      p_worker_name: workerName,
      p_chain_id: chainId,
      p_lease_token: leaseToken
    });
    return resultData(result, "INDEXER_LEASE_RELEASE_FAILED");
  }
});

const verifyCollectionCode = async ({ client, collections, blockNumber }) => {
  for (const page of chunks(collections, 20)) {
    const bytecodes = await Promise.all(page.map((collection) => client.getBytecode({
      address: collection.contract_address,
      blockNumber
    })));
    for (let index = 0; index < page.length; index += 1) {
      if (!bytecodes[index] || keccak256(bytecodes[index]).toLowerCase() !== page[index].deployed_code_hash) {
        throw new Error("COLLECTION_CODE_HASH_MISMATCH");
      }
    }
  }
};

const queryLogs = async ({ client, event, address: emitter, args, fromBlock, toBlock }) => client.getLogs({
  address: emitter,
  event,
  args,
  fromBlock,
  toBlock,
  strict: true
});

const fetchFinalizedEvents = async ({ client, config, assets, orders, fromBlock, toBlock }) => {
  const events = [];
  const knownOrderHashes = new Set(orders.map((order) => order.order_hash));
  const sellers = [...new Set(orders.map((order) => order.seller_address))];
  for (const sellerPage of chunks(sellers, ADDRESS_FILTER_PAGE_SIZE)) {
    const offerer = sellerPage.length === 1 ? sellerPage[0] : sellerPage;
    const [fulfilled, cancelled, counters] = await Promise.all([
      queryLogs({ client, event: ORDER_FULFILLED_EVENT, address: config.secondary.protocolAddress, args: { offerer }, fromBlock, toBlock }),
      queryLogs({ client, event: ORDER_CANCELLED_EVENT, address: config.secondary.protocolAddress, args: { offerer }, fromBlock, toBlock }),
      queryLogs({ client, event: COUNTER_INCREMENTED_EVENT, address: config.secondary.protocolAddress, args: { offerer }, fromBlock, toBlock })
    ]);
    events.push(
      ...fulfilled.map((log) => normalizeFinalizedResaleLog("OrderFulfilled", log))
        .filter((event) => knownOrderHashes.has(event.order_hash)),
      ...cancelled.map((log) => normalizeFinalizedResaleLog("OrderCancelled", log))
        .filter((event) => knownOrderHashes.has(event.order_hash)),
      ...counters.map((log) => normalizeFinalizedResaleLog("CounterIncremented", log))
    );
  }

  for (const collectionPage of chunks(assets.collections, ADDRESS_FILTER_PAGE_SIZE)) {
    const emitters = collectionPage.map((collection) => collection.contract_address);
    const logs = await queryLogs({
      client,
      event: TRANSFER_EVENT,
      address: emitters.length === 1 ? emitters[0] : emitters,
      fromBlock,
      toBlock
    });
    for (const log of logs) {
      const event = normalizeFinalizedResaleLog("Transfer", log);
      const collectionId = assets.collectionIdByAddress.get(event.emitter_address);
      if (collectionId && assets.tokenKeys.has(`${collectionId}:${event.token_id}`)) events.push(event);
    }
  }

  const unique = new Map(events.map((event) => [
    `${event.block_hash}:${event.transaction_hash}:${event.log_index}:${event.removed}`,
    event
  ]));
  const output = [...unique.values()].sort((left, right) =>
    BigInt(left.block_number) < BigInt(right.block_number) ? -1
      : BigInt(left.block_number) > BigInt(right.block_number) ? 1
        : left.transaction_index - right.transaction_index || left.log_index - right.log_index);
  if (output.length > MAX_EVENTS_PER_BLOCK_PAGE) throw new Error("INDEXER_EVENT_PAGE_TOO_LARGE");
  return output;
};

const countInto = (summary, result) => {
  for (const key of ["events_inserted", "fills_finalized", "ownership_updates", "orders_cancelled", "orders_invalidated"]) {
    summary[key] += Number(result?.[key] || 0);
  }
};

export const indexFinalizedOwnership = async ({
  service,
  config = requireSecondaryIndexerConfig(),
  client = clientFor(config),
  repository = createResaleIndexerRepository(service),
  verifyInfrastructure = verifySecondaryInfrastructure,
  blockPageSize = DEFAULT_BLOCK_PAGE_SIZE,
  maxBlockPages = DEFAULT_MAX_BLOCK_PAGES,
  leaseToken = randomUUID()
}) => {
  const chainId = config.wallet.chainId;
  const claimed = await repository.claim({ workerName: WORKER_NAME, chainId, leaseToken });
  if (!claimed) return { status: "locked", worker: WORKER_NAME, chain_id: chainId };

  try {
    const infrastructure = await verifyInfrastructure({ config });
    const finalizedBlock = await client.getBlock({ blockNumber: BigInt(infrastructure.blockNumber) });
    if (!finalizedBlock.hash || finalizedBlock.hash.toLowerCase() !== infrastructure.blockHash.toLowerCase()) {
      throw new Error("FINALIZED_HEAD_CHANGED");
    }

    const [latest, assets, orders] = await Promise.all([
      repository.latestCheckpoint({ workerName: WORKER_NAME, chainId }),
      repository.trackedAssets({ chainId }),
      repository.unresolvedOrders({ chainId })
    ]);
    await verifyCollectionCode({ client, collections: assets.collections, blockNumber: finalizedBlock.number });

    if (latest) {
      const previous = await client.getBlock({ blockNumber: BigInt(latest.through_block_number) });
      if (!previous.hash || previous.hash.toLowerCase() !== latest.through_block_hash) {
        throw new Error("FINALIZED_REORG_DETECTED");
      }
      if (BigInt(latest.through_block_number) > finalizedBlock.number) throw new Error("FINALIZED_HEAD_REGRESSED");
    }

    const firstBlock = latest
      ? BigInt(latest.through_block_number) + 1n
      : BigInt(config.secondary.indexerStartBlock);
    const plan = finalizedBlockRanges({
      fromBlock: firstBlock,
      throughBlock: finalizedBlock.number,
      pageSize: blockPageSize,
      maxPages: maxBlockPages
    });
    const summary = {
      status: "ok",
      worker: WORKER_NAME,
      chain_id: chainId,
      pages: 0,
      events_inserted: 0,
      fills_finalized: 0,
      ownership_updates: 0,
      orders_cancelled: 0,
      orders_invalidated: 0,
      orders_expired: 0
    };
    let previousHash = latest?.through_block_hash || null;

    for (const range of plan.ranges) {
      const [from, through, events] = await Promise.all([
        client.getBlock({ blockNumber: range.fromBlock }),
        range.toBlock === finalizedBlock.number
          ? Promise.resolve(finalizedBlock)
          : client.getBlock({ blockNumber: range.toBlock }),
        fetchFinalizedEvents({ client, config, assets, orders, fromBlock: range.fromBlock, toBlock: range.toBlock })
      ]);
      if (!from.hash || !through.hash) throw new Error("INDEXER_BLOCK_HASH_MISSING");
      if (previousHash && (!from.parentHash || from.parentHash.toLowerCase() !== previousHash)) {
        throw new Error("FINALIZED_PARENT_MISMATCH");
      }
      const confirmedThrough = await client.getBlock({ blockNumber: range.toBlock });
      if (!confirmedThrough.hash || confirmedThrough.hash.toLowerCase() !== through.hash.toLowerCase()) {
        throw new Error("FINALIZED_PAGE_CHANGED");
      }
      const result = await repository.applyBatch({
        p_worker_name: WORKER_NAME,
        p_chain_id: chainId,
        p_lease_token: leaseToken,
        p_indexer_start_block: String(config.secondary.indexerStartBlock),
        p_from_block_number: range.fromBlock.toString(),
        p_from_block_hash: from.hash.toLowerCase(),
        p_previous_block_hash: previousHash,
        p_through_block_number: range.toBlock.toString(),
        p_through_block_hash: through.hash.toLowerCase(),
        p_finalized_block_number: finalizedBlock.number.toString(),
        p_finalized_block_hash: finalizedBlock.hash.toLowerCase(),
        p_events: events
      });
      countInto(summary, result);
      summary.pages += 1;
      previousHash = through.hash.toLowerCase();
    }

    if (plan.caughtUp && (latest || plan.ranges.length)) {
      const expired = await repository.expire({
        p_worker_name: WORKER_NAME,
        p_chain_id: chainId,
        p_lease_token: leaseToken,
        p_finalized_block_number: finalizedBlock.number.toString(),
        p_finalized_block_hash: finalizedBlock.hash.toLowerCase(),
        p_finalized_timestamp: new Date(Number(finalizedBlock.timestamp) * 1_000).toISOString()
      });
      summary.orders_expired = Number(expired || 0);
    }
    return {
      ...summary,
      caught_up: plan.caughtUp,
      next_block_number: plan.nextBlock.toString(),
      finalized_block_number: finalizedBlock.number.toString(),
      finalized_block_hash: finalizedBlock.hash.toLowerCase()
    };
  } finally {
    await repository.release({ workerName: WORKER_NAME, chainId, leaseToken });
  }
};
