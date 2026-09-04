import { ConfigurationError, getRuntimeConfig } from "../../lib/server/config.js";
import { json, problem, readJson, requestFailure } from "../../lib/server/http.js";
import {
  prepareSponsoredSecondaryOperation,
  reconcileSponsoredSecondaryOperation,
  recordRejectedSecondarySponsorship,
  requireSecondarySponsorshipConfig,
  requireSponsorshipReconciliationConfig,
  sponsorshipReplayAllowed,
  sponsorshipWalletContext,
  submitSponsoredSecondaryOperation
} from "../../lib/server/secondary-sponsorship.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../lib/server/supabase.js";
import { attestSmartAccountProfile } from "../../lib/server/wallet.js";
import { normalizeUserOperation, userOperationCommitment, userOperationToJson } from "../../lib/shared/sponsored-userop.js";

const requestKey = (input) => typeof input === "string" && /^[A-Za-z0-9._:-]{16,200}$/.test(input) ? input : null;

const authenticatedAccount = async ({ service, config, userId, action }) => {
  const { data: account, error } = await service.from("smart_accounts")
    .select("id,user_id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,signer_count,threshold,state,recovery_ready,finalized_at")
    .eq("user_id", userId).eq("chain_id", config.wallet.chainId).maybeSingle();
  if (error) throw error;
  const passkeyOnlyOwnerExit = action === "marketplace-transfer"
    && account?.state === "deployed" && account?.recovery_ready === false;
  if (!account || (!passkeyOnlyOwnerExit && (account.state !== "recovery-ready" || !account.recovery_ready)) || !account.finalized_at) {
    throw new Error("SMART_ACCOUNT_NOT_READY");
  }
  const { data: credentials, error: credentialError } = await service.from("wallet_credentials")
    .select("credential_commitment,owner_address,purpose").eq("smart_account_id", account.id).eq("state", "active");
  if (credentialError) throw credentialError;
  const attestation = await attestSmartAccountProfile({ config, account, credentials });
  return { account, attestation };
};

const loadDecision = async ({ service, userId, clientKey }) => {
  const { data, error } = await service.from("sponsorship_decisions")
    .select("id,user_id,smart_account_id,request_key,action,decision,policy_version,target,selector,userop_hash,transaction_hash,provider,quoted_cost_wei,actual_cost_wei,rejection_code,policy_input,created_at,updated_at")
    .eq("user_id", userId).contains("policy_input", { client_request_key: clientKey })
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
};

const authorize = async (request) => {
  const config = getRuntimeConfig();
  const context = createSupabaseRequestClient(request);
  const identity = await getAuthenticatedCurator(context.supabase);
  if (!identity.user) return { response: problem(401, "not_authenticated", "Sign in before requesting sponsored gas.", context.headers) };
  return { config, ...context, ...identity };
};

const exitAction = (action) => ["marketplace-transfer", "resale-cancel-order", "resale-revoke-token", "resale-revoke-usdc"].includes(action);

const preparedPayload = ({ context, account, attestation, prepared, idempotent = false }) => ({
  stage: "prepared",
  request_key: prepared.context.requestKey,
  action: prepared.context.action,
  user_operation: userOperationToJson(prepared.operation),
  operation_commitment: prepared.operationCommitment,
  valid_after: prepared.validAfter,
  valid_until: prepared.validUntil,
  quoted_cost_wei: prepared.quotedCostWei,
  idempotent,
  policy: {
    chain_id: context.config.wallet.chainId,
    protocol_address: context.config.secondary.protocolAddress,
    usdc_address: context.config.secondary.usdcAddress,
    expected_call: prepared.context.expected
  },
  wallet: sponsorshipWalletContext({ config: context.config, account, attestation })
});

const errorResponse = (error, headers) => {
  if (error instanceof ConfigurationError) return problem(503, "sponsorship_not_configured", "Sponsored secondary actions are not available.", headers);
  const badRequest = new Set(["INVALID_SPONSORSHIP_REQUEST", "INVALID_USER_OPERATION", "INVALID_USER_OPERATION_SIGNATURE"]);
  if (badRequest.has(error.message)) return problem(422, "invalid_sponsorship_request", "The sponsored action request is invalid.", headers);
  if (/BUDGET|EXPIRED|CHANGED|MISMATCH|NOT_|REJECTED|REQUIRED|CONFLICT|SATISFIED|APPLICABLE/.test(error.message)) {
    return problem(409, "sponsorship_rejected", "The action is no longer eligible for sponsored execution.", headers);
  }
  return requestFailure(error, headers) || problem(502, "sponsorship_unavailable", "The sponsorship provider or chain check is unavailable.", headers);
};

export const POST = async (request) => {
  let context;
  let body;
  let service;
  let account;
  try {
    context = await authorize(request);
    if (context.response) return context.response;
    if (request.headers.get("origin") !== context.config.siteUrl) {
      return problem(403, "origin_not_allowed", "Sponsored actions must start from the marketplace.", context.headers);
    }
    body = await readJson(request, 60_000);
    if (!["prepare", "submit"].includes(body.stage)) {
      return problem(422, "invalid_sponsorship_stage", "Choose the prepare or submit stage.", context.headers);
    }
    if (body.stage === "prepare") requireSecondarySponsorshipConfig(context.config, body.action);
    if (body.stage === "prepare" && context.curator?.status !== "active" && !exitAction(body.action)) {
      return problem(403, "member_inactive", "Only owner exit, cancellation, and approval revocation remain available while membership is inactive.", context.headers);
    }
    service = createSupabaseServiceClient();
    const prepareKey = body.stage === "prepare" ? requestKey(body.request_key) : null;
    if (body.stage === "prepare" && (!prepareKey || typeof body.action !== "string")) {
      return problem(422, "invalid_sponsorship_request", "The sponsored action request is invalid.", context.headers);
    }
    const submitKey = body.stage === "submit" ? requestKey(body.request_key) : null;
    if (body.stage === "submit" && (!submitKey || !body.user_operation)) {
      return problem(422, "invalid_sponsorship_request", "The signed UserOperation is invalid.", context.headers);
    }
    const decision = body.stage === "submit"
      ? await loadDecision({ service, userId: context.user.id, clientKey: submitKey })
      : null;
    if (body.stage === "submit" && !decision) {
      return problem(404, "sponsorship_not_found", "The sponsorship request was not found.", context.headers);
    }
    const accountContext = await authenticatedAccount({
      service,
      config: context.config,
      userId: context.user.id,
      action: body.stage === "prepare" ? body.action : decision.action
    });
    account = accountContext.account;
    const { attestation } = accountContext;

    if (body.stage === "prepare") {
      const existing = await loadDecision({ service, userId: context.user.id, clientKey: prepareKey });
      if (existing) {
        const referenceKey = body.work_id ? "work_id" : "listing_id";
        const sameRecipient = body.action !== "marketplace-transfer"
          || existing.policy_input?.reference?.recipient_address === String(body.recipient_address || "").toLowerCase();
        const sameRequest = existing.smart_account_id === account.id && existing.action === body.action
          && existing.policy_input?.reference
          && existing.policy_input.reference[referenceKey] === String(body[referenceKey] || "").toLowerCase()
          && sameRecipient;
        if (["submitted", "included"].includes(existing.decision)) {
          throw new Error("SPONSORSHIP_REQUEST_KEY_CONFLICT");
        }
        if (existing.decision === "approved" && Number(existing.policy_input.valid_until) > Math.floor(Date.now() / 1_000)) {
          if (!sameRequest) throw new Error("SPONSORSHIP_REQUEST_KEY_CONFLICT");
          const operation = normalizeUserOperation(existing.policy_input.user_operation);
          if (userOperationCommitment(operation) !== existing.policy_input.operation_commitment) {
            throw new Error("SPONSORSHIP_DECISION_CORRUPT");
          }
          const restored = {
            context: {
              requestKey: existing.policy_input.client_request_key,
              action: existing.action,
              expected: existing.policy_input.expected_call
            },
            operation,
            operationCommitment: existing.policy_input.operation_commitment,
            quotedCostWei: String(existing.quoted_cost_wei),
            validAfter: Number(existing.policy_input.valid_after),
            validUntil: Number(existing.policy_input.valid_until)
          };
          return json(preparedPayload({ context, account, attestation, prepared: restored, idempotent: true }), {
            status: 200,
            headers: context.headers
          });
        }
      }
      const prepared = await prepareSponsoredSecondaryOperation({
        service,
        config: context.config,
        userId: context.user.id,
        account,
        attestation,
        body
      });
      return json(preparedPayload({ context, account, attestation, prepared }), { status: 201, headers: context.headers });
    }

    const key = submitKey;
    if (decision.smart_account_id !== account.id) return problem(404, "sponsorship_not_found", "The sponsorship request was not found.", context.headers);
    requireSecondarySponsorshipConfig(context.config, decision.action);
    if (context.curator?.status !== "active" && !exitAction(decision.action)) {
      return problem(403, "member_inactive", "Only owner exit, cancellation, and approval revocation remain available while membership is inactive.", context.headers);
    }
    const submitted = await submitSponsoredSecondaryOperation({
      service,
      config: context.config,
      userId: context.user.id,
      decision,
      input: body.user_operation
    });
    return json({
      stage: "submitted",
      request_key: key,
      action: decision.action,
      state: submitted.finalized ? "finalized" : submitted.providerAccepted ? "submitted" : "submission-pending",
      userop_hash: submitted.userOperationHash,
      transaction_hash: submitted.finalized ? decision.transaction_hash : null,
      provider_accepted: submitted.providerAccepted,
      idempotent: submitted.alreadySubmitted,
      receipt_url: `/api/wallet/sponsor?request_key=${encodeURIComponent(key)}`
    }, { status: submitted.finalized || submitted.alreadySubmitted ? 200 : 202, headers: context.headers });
  } catch (error) {
    try {
      if (service && context?.user && account && body) {
        await recordRejectedSecondarySponsorship({
          service, config: context.config, userId: context.user.id, accountId: account.id, body, error
        });
      }
    } catch {}
    return errorResponse(error, context?.headers);
  }
};

export const GET = async (request) => {
  let context;
  try {
    context = await authorize(request);
    if (context.response) return context.response;
    const key = requestKey(new URL(request.url).searchParams.get("request_key"));
    if (!key) return problem(422, "invalid_sponsorship_request", "A valid sponsorship request key is required.", context.headers);
    const service = createSupabaseServiceClient();
    const decision = await loadDecision({ service, userId: context.user.id, clientKey: key });
    if (!decision) return problem(404, "sponsorship_not_found", "The sponsorship request was not found.", context.headers);
    if (decision.decision === "approved") return json({ request_key: key, action: decision.action, state: "approved" }, { headers: context.headers });
    if (decision.decision === "rejected" || decision.decision === "failed") {
      return json({
        request_key: key,
        action: decision.action,
        state: "failed",
        userop_hash: decision.userop_hash,
        transaction_hash: decision.transaction_hash,
        rejection_code: decision.rejection_code
      }, { headers: context.headers });
    }
    if (decision.decision === "included") {
      return json({
        request_key: key, action: decision.action, state: "finalized",
        userop_hash: decision.userop_hash, transaction_hash: decision.transaction_hash,
        actual_cost_wei: String(decision.actual_cost_wei)
      }, { headers: context.headers });
    }
    requireSponsorshipReconciliationConfig(context.config, decision.action);
    const result = await reconcileSponsoredSecondaryOperation({
      service,
      config: context.config,
      decision,
      allowReplay: sponsorshipReplayAllowed(context.config, decision.action)
    });
    return json({
      request_key: key,
      action: decision.action,
      state: result.state,
      userop_hash: decision.userop_hash,
      transaction_hash: result.transactionHash,
      block_number: result.blockNumber,
      block_hash: result.blockHash,
      finalized_block_number: result.finalizedBlockNumber,
      finalized_block_hash: result.finalizedBlockHash,
      actual_cost_wei: result.actualCostWei
    }, { headers: context.headers });
  } catch (error) {
    return errorResponse(error, context?.headers);
  }
};
