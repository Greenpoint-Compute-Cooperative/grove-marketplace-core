import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../../lib/server/config.js";
import { json, problem, requestFailure } from "../../../lib/server/http.js";
import { loadAuthenticatedResaleSellerAction } from "../../../lib/server/resale-seller-actions.js";

export const POST = async (request) => {
  try {
    const loaded = await loadAuthenticatedResaleSellerAction(request);
    if (loaded.response) return loaded.response;
    const { headers, order, inspection } = loaded;
    if (inspection.cancellation.required) {
      return problem(
        409,
        "cancel_order_first",
        "Finalize the exact Seaport order cancellation before revoking its token approval.",
        headers
      );
    }
    if (!inspection.chainState.sellerOwnsToken) {
      return problem(409, "seller_not_token_owner", "The seller Safe no longer owns this token.", headers);
    }
    const action = inspection.revocation.action;
    const requestKey = action ? randomUUID() : null;
    const actions = action ? [{
      ...action,
      request_key: requestKey,
      sponsor_request: {
        stage: "prepare",
        request_key: requestKey,
        action: action.action,
        work_id: order.work_id
      }
    }] : [];
    return json({
      listing: { id: order.id, order_hash: inspection.orderHash, state: order.state },
      chain_state: inspection.chainState,
      evidence: inspection.evidence,
      revocation: {
        required: inspection.revocation.required,
        reason: inspection.revocation.reason
      },
      actions,
      sponsorship: {
        submission: "not-submitted",
        policy_actions: actions.map((action) => action.action)
      }
    }, { headers: { ...Object.fromEntries(headers), "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return problem(503, "secondary_not_configured", "Secondary seller actions are not available.");
    }
    return requestFailure(error)
      || problem(502, "revocation_context_unavailable", "The approval-revocation action could not be prepared.");
  }
};
