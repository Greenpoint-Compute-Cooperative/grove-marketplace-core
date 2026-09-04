const STALE_AFTER_MS = 15 * 60_000;

export const publicMarketStats = ({ row, chainId, environment, now = Date.now() }) => {
  const network = Number(chainId) === 1 ? "ethereum-mainnet"
    : Number(chainId) === 11155111 ? "ethereum-sepolia" : "disabled";
  if (!row) {
    return {
      status: "syncing",
      environment,
      network,
      reason: "no-complete-snapshot",
      as_of: null,
      stats: null
    };
  }
  const computedAt = Date.parse(row.computed_at);
  const stale = !Number.isFinite(computedAt) || now - computedAt > STALE_AFTER_MS;
  const ready = row.state === "ready" && !stale;
  return {
    status: ready ? "ready" : "syncing",
    environment,
    network,
    reason: ready ? null : stale ? "stale-snapshot" : "ownership-coverage-incomplete",
    as_of: {
      chain_id: Number(chainId),
      finalized_block: String(row.indexed_through_block),
      block_hash: row.indexed_through_hash,
      computed_at: row.computed_at,
      schema_version: row.schema_version
    },
    stats: ready ? row.stats : null
  };
};

export const marketStatsEtag = (result) => {
  if (!result.as_of) return '"market-stats-syncing"';
  const timestamp = Date.parse(result.as_of.computed_at);
  return `"${result.as_of.schema_version}-${result.as_of.chain_id}-${result.as_of.finalized_block}-${Number.isFinite(timestamp) ? timestamp : 0}"`;
};
