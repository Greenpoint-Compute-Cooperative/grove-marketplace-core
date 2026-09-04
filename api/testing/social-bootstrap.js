import { ConfigurationError, requireSyntheticSocialAuthConfig } from "../../lib/server/config.js";
import { json, problem, readJson, requestFailure } from "../../lib/server/http.js";
import { createSupabaseServiceClient } from "../../lib/server/supabase.js";
import {
  issueSyntheticSocialTicket,
  secureBearerEqual,
  syntheticCuratorAttributes
} from "../../lib/server/synthetic-social-auth.js";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

const resolveIdentity = async (service, identity) => {
  const args = {
    environment_input: "staging",
    provider_subject_input: identity.providerSubject,
    email_input: identity.email,
    display_name_input: identity.displayName,
    handle_input: identity.handle
  };
  let resolved = await service.rpc("resolve_synthetic_social_identity", args);
  if (resolved.error) throw resolved.error;
  if (resolved.data?.length) return resolved.data[0];

  const created = await service.auth.admin.createUser({
    email: identity.email,
    email_confirm: true,
    user_metadata: identity.userMetadata,
    app_metadata: { synthetic_social_e2e: true, synthetic_environment: "staging" }
  });
  if (created.error && !/already|registered|exists/i.test(created.error.message || "")) throw created.error;
  resolved = await service.rpc("resolve_synthetic_social_identity", args);
  if (resolved.error || !resolved.data?.length) throw resolved.error || new Error("SYNTHETIC_IDENTITY_UNAVAILABLE");
  return resolved.data[0];
};

export const POST = async (request) => {
  try {
    const config = requireSyntheticSocialAuthConfig();
    if (!secureBearerEqual(request.headers.get("authorization"), config.syntheticSocialAuth.operatorToken)) {
      return problem(401, "not_authorized", "Synthetic staging bootstrap authorization is required.", PRIVATE_HEADERS);
    }
    const body = await readJson(request, 2_048);
    const identity = syntheticCuratorAttributes(body.scenario);
    const service = createSupabaseServiceClient();
    const resolved = await resolveIdentity(service, identity);
    const ticket = issueSyntheticSocialTicket({
      signingSecret: config.syntheticSocialAuth.signingSecret,
      scenario: identity.scenario,
      ttlSeconds: config.syntheticSocialAuth.ticketTtlSeconds
    });
    const { error } = await service.rpc("issue_synthetic_social_auth_ticket", {
      ticket_id_input: ticket.claims.jti,
      environment_input: "staging",
      auth_user_id_input: resolved.user_id,
      provider_subject_input: identity.providerSubject,
      token_digest_input: ticket.digest,
      issued_at_input: new Date(ticket.claims.iat * 1000).toISOString(),
      expires_at_input: new Date(ticket.claims.exp * 1000).toISOString(),
      evidence_input: {
        purpose: "deterministic-auction-e2e",
        scenario: identity.scenario,
        ticket_version: 1,
        wallet_authority: false
      }
    });
    if (error) throw error;
    return json({
      token: ticket.token,
      expires_at: new Date(ticket.claims.exp * 1000).toISOString(),
      synthetic_curator: {
        id: resolved.user_id,
        provider: "synthetic",
        display_name: identity.displayName,
        handle: identity.handle
      }
    }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return problem(503, "synthetic_social_auth_unavailable", "Synthetic social authentication is unavailable.", PRIVATE_HEADERS);
    }
    if (["SYNTHETIC_SCENARIO_INVALID", "SYNTHETIC_TICKET_CONFIGURATION_INVALID"].includes(error.message)) {
      return problem(422, "synthetic_identity_invalid", "The synthetic test identity is invalid.", PRIVATE_HEADERS);
    }
    return requestFailure(error, PRIVATE_HEADERS)
      || problem(503, "synthetic_social_bootstrap_failed", "The synthetic staging identity could not be prepared.", PRIVATE_HEADERS);
  }
};
