import { getRuntimeConfig } from "../../lib/server/config.js";
import { json, problem, requestFailure } from "../../lib/server/http.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../lib/server/supabase.js";

export const GET = async (request) => {
  try {
    const config = getRuntimeConfig();
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in to view your NFTs.", headers);

    const service = createSupabaseServiceClient();
    const { data: account, error: accountError } = await service.from("smart_accounts")
      .select("id,chain_id,account_address,state,recovery_ready,finalized_at")
      .eq("user_id", user.id).eq("chain_id", config.wallet.chainId).maybeSingle();
    if (accountError) return problem(502, "wallet_assets_unavailable", "Your NFT ownership could not be loaded.", headers);
    if (!account) return json({ wallet: null, assets: [] }, {
      headers: { ...Object.fromEntries(headers), "Cache-Control": "private, no-store" }
    });

    const { data: ownership, error: ownershipError } = await service.from("token_ownership_projection")
      .select("work_id,collection_id,collection_address,token_id,owner_address,ownership_state,finality,observed_block_number,observed_block_hash")
      .eq("chain_id", config.wallet.chainId).eq("owner_smart_account_id", account.id)
      .eq("ownership_state", "owned").eq("finality", "finalized")
      .order("observed_block_number", { ascending: false });
    if (ownershipError) return problem(502, "wallet_assets_unavailable", "Your NFT ownership could not be loaded.", headers);

    const workIds = (ownership || []).map((entry) => entry.work_id);
    const worksResult = workIds.length
      ? await service.from("works").select("id,slug,title,artist_name,media_url,format,contract_status,nft_quantity").in("id", workIds)
      : { data: [], error: null };
    if (worksResult.error) return problem(502, "wallet_assets_unavailable", "Your NFT details could not be loaded.", headers);
    const works = new Map((worksResult.data || []).map((work) => [work.id, work]));

    const assets = (ownership || []).flatMap((entry) => {
      const work = works.get(entry.work_id);
      if (!work || work.format !== "digital" || work.contract_status !== "minted" || String(work.nft_quantity) !== "1") return [];
      return [{
        work_id: work.id,
        slug: work.slug,
        title: work.title,
        artist_name: work.artist_name,
        media_url: work.media_url,
        standard: "ERC721",
        chain_id: config.wallet.chainId,
        collection_id: entry.collection_id,
        collection_address: entry.collection_address,
        token_id: String(entry.token_id),
        owner_address: entry.owner_address,
        finality: entry.finality,
        observed_block_number: String(entry.observed_block_number),
        observed_block_hash: entry.observed_block_hash
      }];
    });
    return json({
      wallet: {
        account_address: account.account_address,
        state: account.state,
        recovery_ready: account.recovery_ready,
        owner_exit_configured: config.wallet.ownerExitExecutableConfigured
      },
      assets
    }, { headers: { ...Object.fromEntries(headers), "Cache-Control": "private, no-store" } });
  } catch (error) {
    return requestFailure(error) || problem(502, "wallet_assets_unavailable", "Your NFT ownership could not be loaded.");
  }
};
