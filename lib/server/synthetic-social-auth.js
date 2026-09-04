import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const ISSUER = "grove-staging";
const AUDIENCE = "grove-synthetic-social-bootstrap";
const MAX_TICKET_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const SCENARIO = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

const base64url = (input) => Buffer.from(input).toString("base64url");

const secureEqual = (left, right) => {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

export const secureBearerEqual = (header, expected) => {
  const supplied = String(header || "").replace(/^Bearer\s+/i, "");
  return secureEqual(supplied, expected);
};

export const normalizeSyntheticScenario = (input) => {
  const scenario = String(input || "auction-e2e").trim().toLowerCase();
  if (!SCENARIO.test(scenario)) throw new Error("SYNTHETIC_SCENARIO_INVALID");
  return scenario;
};

export const syntheticCuratorAttributes = (input) => {
  const scenario = normalizeSyntheticScenario(input);
  const providerSubject = `synthetic:staging:${scenario}`;
  const emailKey = createHash("sha256").update(providerSubject).digest("hex").slice(0, 24);
  return {
    scenario,
    provider: "synthetic",
    providerSubject,
    email: `grove-synthetic-${emailKey}@staging.invalid`,
    displayName: `Synthetic Staging Bidder · ${scenario}`,
    handle: `synthetic-${scenario}`,
    userMetadata: {
      synthetic_social_e2e: true,
      synthetic_provider_subject: providerSubject,
      synthetic_environment: "staging"
    }
  };
};

export const syntheticTicketDigest = (token) => createHash("sha256")
  .update(String(token || ""), "utf8").digest("hex");

export const issueSyntheticSocialTicket = ({
  signingSecret,
  scenario,
  ttlSeconds = 120,
  now = Date.now(),
  ticketId = randomUUID()
}) => {
  if (Buffer.byteLength(String(signingSecret || ""), "utf8") < 32
      || !Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > MAX_TICKET_SECONDS
      || !UUID.test(ticketId)) throw new Error("SYNTHETIC_TICKET_CONFIGURATION_INVALID");
  const identity = syntheticCuratorAttributes(scenario);
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    v: 1,
    iss: ISSUER,
    aud: AUDIENCE,
    jti: ticketId.toLowerCase(),
    sub: identity.providerSubject,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds
  };
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", signingSecret).update(payload).digest("base64url");
  const token = `${payload}.${signature}`;
  return { token, claims, digest: syntheticTicketDigest(token), identity };
};

export const verifySyntheticSocialTicket = ({ token, signingSecret, now = Date.now() }) => {
  if (Buffer.byteLength(String(signingSecret || ""), "utf8") < 32) throw new Error("SYNTHETIC_TICKET_INVALID");
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts.every((part) => SEGMENT.test(part))) throw new Error("SYNTHETIC_TICKET_INVALID");
  const [payload, suppliedSignature] = parts;
  const expectedSignature = createHmac("sha256", signingSecret).update(payload).digest("base64url");
  if (!secureEqual(suppliedSignature, expectedSignature)) throw new Error("SYNTHETIC_TICKET_INVALID");

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("SYNTHETIC_TICKET_INVALID");
  }
  const nowSeconds = Math.floor(now / 1000);
  if (!claims || Array.isArray(claims) || claims.v !== 1 || claims.iss !== ISSUER || claims.aud !== AUDIENCE
      || !UUID.test(String(claims.jti || "")) || typeof claims.sub !== "string"
      || !claims.sub.startsWith("synthetic:staging:")
      || !SCENARIO.test(claims.sub.slice("synthetic:staging:".length))
      || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
      || claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TICKET_SECONDS
      || claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds) throw new Error("SYNTHETIC_TICKET_INVALID");
  return { claims, digest: syntheticTicketDigest(token), identity: syntheticCuratorAttributes(claims.sub.slice("synthetic:staging:".length)) };
};

export const sameDeploymentOrigin = (request, configuredSiteUrl) => {
  let requestOrigin;
  let allowedOrigin;
  try {
    requestOrigin = new URL(request.url).origin;
    allowedOrigin = new URL(configuredSiteUrl).origin;
  } catch {
    return false;
  }
  if (requestOrigin !== allowedOrigin) return false;
  const origin = request.headers.get("origin");
  if (origin) return origin === allowedOrigin;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === allowedOrigin;
  } catch {
    return false;
  }
};
