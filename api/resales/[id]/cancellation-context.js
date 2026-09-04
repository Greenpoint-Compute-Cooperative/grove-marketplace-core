import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../../lib/server/config.js";
import { json, problem, requestFailure } from "../../../lib/server/http.js";
import { loadAuthenticatedResaleSellerAction } from "../../../lib/server/resale-seller-actions.js";

export const POST = async (request) => {
  try {
    const loaded = await loadAuthenticatedResaleSellerAction(request);
    if (loaded.response) return loaded.response;
    const { headers, order, inspection } = loaded;
    const action = inspection.cancellation.action;
    const requestKey = action ? randomUUID() : null;
    const actions = action ? [{
      ...action,
      request_key: requestKey,
      sponsor_request: {
        stage: "prepare",
        request_key: requestKey,
        action: action.action,
        listing_id: order.id
      }
    }] : [];
    return json({
      listing: { id: order.id, order_hash: inspection.orderHash, state: order.state },
      chain_state: inspection.chainState,
      evidence: inspection.evidence,
      cancellation: {
        required: inspection.cancellation.required,
        reason: inspection.cancellation.reason
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
      || problem(502, "cancellation_context_unavailable", "The cancellation action could not be prepared.");
  }
};
