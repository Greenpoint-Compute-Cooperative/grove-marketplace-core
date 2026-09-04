import { ConfigurationError, requireSyntheticSocialAuthConfig } from "../../lib/server/config.js";
import { json, problem, readJson, requestFailure } from "../../lib/server/http.js";
import { createSupabaseRequestClient, createSupabaseServiceClient, getAuthenticatedCurator } from "../../lib/server/supabase.js";
import {
  sameDeploymentOrigin,
  verifySyntheticSocialTicket
} from "../../lib/server/synthetic-social-auth.js";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export const POST = async (request) => {
  try {
    const config = requireSyntheticSocialAuthConfig();
    if (!sameDeploymentOrigin(request, config.siteUrl)) {
      return problem(403, "origin_not_allowed", "Synthetic staging sign-in must start from this deployment.", PRIVATE_HEADERS);
    }
    const body = await readJson(request, 4_096);
    const verified = verifySyntheticSocialTicket({
      token: body.token,
      signingSecret: config.syntheticSocialAuth.signingSecret
    });
    const service = createSupabaseServiceClient();
    const { data: ticket, error: ticketError } = await service.from("synthetic_social_auth_tickets")
      .select("id,environment,auth_user_id,provider_subject,token_digest,expires_at,consumed_at")
      .eq("id", verified.claims.jti).maybeSingle();
    if (ticketError || !ticket || ticket.environment !== "staging" || ticket.auth_user_id === null
        || ticket.provider_subject !== verified.claims.sub || ticket.token_digest !== verified.digest
        || ticket.consumed_at || new Date(ticket.expires_at).getTime() <= Date.now()) {
      return problem(401, "synthetic_ticket_invalid", "The synthetic staging ticket is invalid or expired.", PRIVATE_HEADERS);
    }
    const { data: userResult, error: userError } = await service.auth.admin.getUserById(ticket.auth_user_id);
    const syntheticUser = userResult?.user;
    if (userError || !syntheticUser?.email || syntheticUser.user_metadata?.synthetic_social_e2e !== true
        || syntheticUser.user_metadata?.synthetic_provider_subject !== verified.claims.sub) {
      return problem(401, "synthetic_identity_invalid", "The synthetic staging identity is unavailable.", PRIVATE_HEADERS);
    }
    const generated = await service.auth.admin.generateLink({
      type: "magiclink",
      email: syntheticUser.email,
      options: { redirectTo: config.siteUrl }
    });
    const tokenHash = generated.data?.properties?.hashed_token;
    const verificationType = generated.data?.properties?.verification_type || "magiclink";
    if (generated.error || !tokenHash || !["email", "magiclink"].includes(verificationType)) {
      return problem(503, "synthetic_session_unavailable", "The synthetic staging session could not be created.", PRIVATE_HEADERS);
    }
    const consumed = await service.rpc("consume_synthetic_social_auth_ticket", {
      ticket_id_input: ticket.id,
      token_digest_input: verified.digest,
      auth_user_id_input: ticket.auth_user_id
    });
    if (consumed.error || consumed.data !== true) {
      return problem(401, "synthetic_ticket_invalid", "The synthetic staging ticket is invalid or expired.", PRIVATE_HEADERS);
    }

    const requestContext = createSupabaseRequestClient(request);
    const verifiedOtp = await requestContext.supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: verificationType
    });
    if (verifiedOtp.error || verifiedOtp.data.user?.id !== ticket.auth_user_id) {
      return problem(503, "synthetic_session_unavailable", "The synthetic staging session could not be created.", requestContext.headers);
    }
    const identity = await getAuthenticatedCurator(requestContext.supabase);
    if (!identity.curator || identity.curator.provider !== "synthetic" || identity.curator.status !== "active") {
      await requestContext.supabase.auth.signOut();
      return problem(503, "synthetic_identity_invalid", "The synthetic staging identity is unavailable.", requestContext.headers);
    }
    const marked = await service.rpc("mark_synthetic_social_session_established", {
      ticket_id_input: ticket.id,
      auth_user_id_input: ticket.auth_user_id
    });
    if (marked.error || marked.data !== true) {
      console.error(JSON.stringify({ level: "error", operation: "synthetic_session_audit", code: marked.error?.code || "audit_failed" }));
      await requestContext.supabase.auth.signOut();
      return problem(503, "synthetic_session_audit_failed", "The synthetic staging session was not recorded.", requestContext.headers);
    }
    return json({ authenticated: true, synthetic: true, curator: identity.curator }, { headers: requestContext.headers });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return problem(503, "synthetic_social_auth_unavailable", "Synthetic social authentication is unavailable.", PRIVATE_HEADERS);
    }
    if (error.message === "SYNTHETIC_TICKET_INVALID") {
      return problem(401, "synthetic_ticket_invalid", "The synthetic staging ticket is invalid or expired.", PRIVATE_HEADERS);
    }
    return requestFailure(error, PRIVATE_HEADERS)
      || problem(503, "synthetic_session_unavailable", "The synthetic staging session could not be created.", PRIVATE_HEADERS);
  }
};
