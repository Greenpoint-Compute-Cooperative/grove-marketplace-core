import assert from "node:assert/strict";
import { keccak256 } from "viem";
import {
  finalizedBlockRanges,
  indexFinalizedOwnership,
  normalizeFinalizedResaleLog
} from "../lib/server/resale-indexer.js";
import { SEAPORT_1_6_ADDRESS } from "../lib/shared/resale-order.js";

const hash = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const address = (value) => `0x${BigInt(value).toString(16).padStart(40, "0")}`;
const baseLog = ({ emitter = address(2), block = 10n, transactionIndex = 0, logIndex = 0, args }) => ({
  address: emitter,
  transactionHash: hash(block * 100n + BigInt(logIndex) + 1n),
  transactionIndex,
  logIndex,
  blockNumber: block,
  blockHash: hash(block),
  args
});

assert.deepEqual(finalizedBlockRanges({ fromBlock: 10n, throughBlock: 25n, pageSize: 5n, maxPages: 2 }), {
  ranges: [{ fromBlock: 10n, toBlock: 14n }, { fromBlock: 15n, toBlock: 19n }],
  nextBlock: 20n,
  caughtUp: false
});
assert.deepEqual(finalizedBlockRanges({ fromBlock: 26n, throughBlock: 25n }), {
  ranges: [], nextBlock: 26n, caughtUp: true
});

const transfer = normalizeFinalizedResaleLog("Transfer", baseLog({
  args: { from: address(1), to: address(3), tokenId: 7n }
}));
assert.equal(transfer.event_name, "Transfer");
assert.equal(transfer.token_id, "7");
assert.equal(transfer.to_address, address(3));
assert.match(transfer.payload_hash, /^0x[0-9a-f]{64}$/);
assert.throws(() => normalizeFinalizedResaleLog("Transfer", {
  ...baseLog({ args: { from: address(1), to: address(3), tokenId: 7n } }),
  removed: true
}), /NON_FINAL_LOG_REJECTED/);

const fulfilled = normalizeFinalizedResaleLog("OrderFulfilled", baseLog({
  emitter: SEAPORT_1_6_ADDRESS,
  logIndex: 4,
  args: {
    orderHash: hash(99),
    offerer: address(4),
    zone: address(0),
    recipient: address(5),
    offer: [{ itemType: 2, token: address(2), identifier: 7n, amount: 1n }],
    consideration: [{ itemType: 1, token: address(6), identifier: 0n, amount: 1_000_000n, recipient: address(4) }]
  }
}));
assert.equal(fulfilled.order_hash, hash(99));
assert.equal(fulfilled.event_data.offer[0].identifier, "7");
assert.equal(fulfilled.event_data.consideration[0].amount, "1000000");

const collectionAddress = address(2);
const bytecode = "0x6000";
const config = {
  wallet: { chainId: 11155111 },
  secondary: {
    protocolAddress: SEAPORT_1_6_ADDRESS.toLowerCase(),
    indexerStartBlock: 10
  }
};
const calls = { applied: [], expired: 0, released: 0, logs: 0 };
const repository = {
  claim: async () => true,
  latestCheckpoint: async () => null,
  trackedAssets: async () => ({
    collections: [{ id: "collection-1", contract_address: collectionAddress, deployed_code_hash: keccak256(bytecode) }],
    tokenKeys: new Set(["collection-1:7"]),
    collectionIdByAddress: new Map([[collectionAddress, "collection-1"]])
  }),
  unresolvedOrders: async () => [],
  applyBatch: async (input) => {
    calls.applied.push(input);
    return { events_inserted: 0, fills_finalized: 0, ownership_updates: 0, orders_cancelled: 0, orders_invalidated: 0 };
  },
  expire: async () => { calls.expired += 1; return 0; },
  release: async () => { calls.released += 1; return true; }
};
const client = {
  getBlock: async ({ blockNumber }) => ({
    number: blockNumber,
    hash: hash(blockNumber),
    parentHash: hash(blockNumber - 1n),
    timestamp: 1_788_000_000n
  }),
  getBytecode: async () => bytecode,
  getLogs: async () => { calls.logs += 1; return []; }
};
const firstRun = await indexFinalizedOwnership({
  service: {}, config, client, repository,
  verifyInfrastructure: async () => ({ blockNumber: 25n, blockHash: hash(25) }),
  blockPageSize: 5n, maxBlockPages: 2, leaseToken: "10000000-0000-4000-8000-000000000001"
});
assert.equal(firstRun.caught_up, false);
assert.equal(firstRun.next_block_number, "20");
assert.deepEqual(calls.applied.map((call) => [call.p_from_block_number, call.p_through_block_number]), [["10", "14"], ["15", "19"]]);
assert.equal(calls.applied[0].p_previous_block_hash, null);
assert.equal(calls.applied[1].p_previous_block_hash, hash(14));
assert.equal(calls.expired, 0, "expiry waits until every finalized page is reconciled");
assert.equal(calls.released, 1, "the worker lease is released after a successful bounded run");

let reorgReleased = false;
await assert.rejects(indexFinalizedOwnership({
  service: {}, config, client,
  repository: {
    ...repository,
    latestCheckpoint: async () => ({ through_block_number: "20", through_block_hash: hash(19) }),
    release: async () => { reorgReleased = true; return true; }
  },
  verifyInfrastructure: async () => ({ blockNumber: 25n, blockHash: hash(25) }),
  leaseToken: "10000000-0000-4000-8000-000000000002"
}), /FINALIZED_REORG_DETECTED/);
assert.equal(reorgReleased, true, "a finalized-hash disagreement releases the lease without advancing state");

let finalizedReads = 0;
let unstableApplied = false;
await assert.rejects(indexFinalizedOwnership({
  service: {}, config,
  client: {
    ...client,
    getBlock: async ({ blockNumber }) => {
      if (blockNumber === 14n) {
        finalizedReads += 1;
        return {
          number: blockNumber,
          hash: finalizedReads === 1 ? hash(14) : hash(1_400),
          timestamp: 1_788_000_000n
        };
      }
      return { number: blockNumber, hash: hash(blockNumber), timestamp: 1_788_000_000n };
    }
  },
  repository: {
    ...repository,
    applyBatch: async () => { unstableApplied = true; }
  },
  verifyInfrastructure: async () => ({ blockNumber: 14n, blockHash: hash(14) }),
  blockPageSize: 5n,
  maxBlockPages: 1,
  leaseToken: "10000000-0000-4000-8000-000000000004"
}), /FINALIZED_PAGE_CHANGED/);
assert.equal(unstableApplied, false, "a page whose finalized boundary changed is never committed");

const locked = await indexFinalizedOwnership({
  service: {}, config, client,
  repository: { ...repository, claim: async () => false },
  verifyInfrastructure: async () => { throw new Error("must not run"); },
  leaseToken: "10000000-0000-4000-8000-000000000003"
});
assert.equal(locked.status, "locked");

console.log("Secondary indexer checks passed: normalization, bounded pagination, locking, continuity, and finalized reorg stop.");
