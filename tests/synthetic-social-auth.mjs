import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getRuntimeConfig, publicConfiguration, requireSyntheticSocialAuthConfig } from "../lib/server/config.js";
import {
  issueSyntheticSocialTicket,
  normalizeSyntheticScenario,
  sameDeploymentOrigin,
  secureBearerEqual,
  syntheticCuratorAttributes,
  verifySyntheticSocialTicket
} from "../lib/server/synthetic-social-auth.js";
import { POST as issueBootstrap } from "../api/testing/social-bootstrap.js";
import { POST as openSyntheticSession } from "../api/testing/social-session.js";

const secret = "s".repeat(64);
const ticket = issueSyntheticSocialTicket({
  signingSecret: secret,
  scenario: "auction-e2e",
  now: Date.parse("2026-09-04T12:00:00.000Z"),
  ticketId: "40000000-0000-4000-8000-000000000001"
});
assert.equal(ticket.claims.sub, "synthetic:staging:auction-e2e");
assert.equal(ticket.claims.exp - ticket.claims.iat, 120);
assert.equal(ticket.digest.length, 64);
const verified = verifySyntheticSocialTicket({
  token: ticket.token,
  signingSecret: secret,
  now: Date.parse("2026-09-04T12:01:00.000Z")
});
assert.equal(verified.claims.jti, "40000000-0000-4000-8000-000000000001");
assert.equal(verified.identity.provider, "synthetic");
assert.equal(verified.identity.userMetadata.synthetic_social_e2e, true);
assert.throws(() => verifySyntheticSocialTicket({
  token: `${ticket.token.slice(0, -1)}x`, signingSecret: secret,
  now: Date.parse("2026-09-04T12:01:00.000Z")
}), /SYNTHETIC_TICKET_INVALID/);
assert.throws(() => verifySyntheticSocialTicket({
  token: ticket.token, signingSecret: secret,
  now: Date.parse("2026-09-04T12:03:00.000Z")
}), /SYNTHETIC_TICKET_INVALID/);
assert.throws(() => normalizeSyntheticScenario("real_person@example.com"), /SYNTHETIC_SCENARIO_INVALID/);
const identity = syntheticCuratorAttributes("bid-race-1");
assert.match(identity.email, /^grove-synthetic-[0-9a-f]{24}@staging\.invalid$/);
assert.equal(JSON.stringify(identity).includes("wallet"), false);
assert.equal(secureBearerEqual(`Bearer ${secret}`, secret), true);
assert.equal(secureBearerEqual(`Bearer ${secret}x`, secret), false);
assert.equal(sameDeploymentOrigin(new Request("https://stable-stage.example/api/testing/social-session", {
  method: "POST", headers: { Origin: "https://stable-stage.example" }
}), "https://stable-stage.example"), true);
assert.equal(sameDeploymentOrigin(new Request("https://stage-deployment.example/api/testing/social-session", {
  method: "POST", headers: { Origin: "https://stage-deployment.example" }
}), "https://stable-stage.example"), false);
assert.equal(sameDeploymentOrigin(new Request("https://stage.example/api/testing/social-session", {
  method: "POST", headers: { Origin: "https://attacker.example" }
}), "https://stable-stage.example"), false);

const envNames = [
  "VERCEL_ENV", "VERCEL_TARGET_ENV", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY",
  "GROVE_SITE_URL", "GROVE_SYNTHETIC_SOCIAL_AUTH_ENABLED", "GROVE_STAGING_SUPABASE_PROJECT_REF", "GROVE_SYNTHETIC_SOCIAL_AUTH_SIGNING_SECRET",
  "GROVE_SYNTHETIC_SOCIAL_AUTH_OPERATOR_TOKEN"
];
const prior = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
for (const name of envNames) delete process.env[name];
const unavailableBootstrap = await issueBootstrap(new Request("https://stage.example/api/testing/social-bootstrap", {
  method: "POST", body: "{}"
}));
assert.equal(unavailableBootstrap.status, 503);
assert.equal(unavailableBootstrap.headers.get("cache-control"), "private, no-store");
const unavailableSession = await openSyntheticSession(new Request("https://stage.example/api/testing/social-session", {
  method: "POST", body: "{}"
}));
assert.equal(unavailableSession.status, 503);
assert.equal(unavailableSession.headers.get("cache-control"), "private, no-store");

Object.assign(process.env, {
  VERCEL_ENV: "preview",
  VERCEL_TARGET_ENV: "staging",
  SUPABASE_URL: "https://stagingprojectref123.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "publishable",
  SUPABASE_SECRET_KEY: "secret",
  GROVE_SITE_URL: "https://stage.example",
  GROVE_SYNTHETIC_SOCIAL_AUTH_ENABLED: "true",
  GROVE_STAGING_SUPABASE_PROJECT_REF: "stagingprojectref123",
  GROVE_SYNTHETIC_SOCIAL_AUTH_SIGNING_SECRET: secret,
  GROVE_SYNTHETIC_SOCIAL_AUTH_OPERATOR_TOKEN: "o".repeat(64)
});
assert.equal(getRuntimeConfig().syntheticSocialAuth.configured, true);
assert.equal(requireSyntheticSocialAuthConfig().targetEnvironment, "staging");
process.env.GROVE_STAGING_SUPABASE_PROJECT_REF = "wrongprojectref12345";
assert.equal(getRuntimeConfig().syntheticSocialAuth.configured, false,
  "A staging label cannot authorize the harness against a different Supabase project");
process.env.GROVE_STAGING_SUPABASE_PROJECT_REF = "stagingprojectref123";
assert.doesNotMatch(JSON.stringify(publicConfiguration()), /synthetic|operator|signing/i,
  "Synthetic identity gates and secrets are never advertised to the browser");
process.env.VERCEL_ENV = "production";
assert.equal(getRuntimeConfig().syntheticSocialAuth.configured, false, "Production refuses the synthetic login even with every secret present");
assert.throws(() => requireSyntheticSocialAuthConfig(), /only in the isolated staging environment/);

const migration = await readFile(new URL("../supabase/migrations/20260912000000_synthetic_staging_social_auth.sql", import.meta.url), "utf8");
for (const table of ["synthetic_social_auth_tickets", "synthetic_social_auth_audit"]) {
  assert.match(migration, new RegExp(`create table public\\.${table}`));
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
}
assert.match(migration, /provider in \('instagram', 'x', 'synthetic'\)/);
assert.match(migration, /examplepreviewrefxxxx\.supabase\.co/,
  "database RPCs are pinned to the isolated staging Supabase host");
assert.match(migration, /evidence ->> 'wallet_authority' = 'false'/);
assert.match(migration, /for update/, "Ticket consumption is serialized");
assert.match(migration, /consumed_at is not null/, "Tickets are one-time");
assert.match(migration, /revoke all on function public\.consume_synthetic_social_auth_ticket/);
assert.match(migration, /grant execute on function public\.consume_synthetic_social_auth_ticket[\s\S]*to service_role/);
const [issueRoute, sessionRoute] = await Promise.all([
  readFile(new URL("../api/testing/social-bootstrap.js", import.meta.url), "utf8"),
  readFile(new URL("../api/testing/social-session.js", import.meta.url), "utf8")
]);
assert.doesNotMatch(`${issueRoute}\n${sessionRoute}`, /wallet_links|smart_accounts|wallet_credentials/,
  "Synthetic social authentication does not create wallet authority");
assert.match(sessionRoute, /generateLink/);
assert.match(sessionRoute, /verifyOtp/);
assert.match(sessionRoute, /if \(marked\.error \|\| marked\.data !== true\)[\s\S]*signOut\(\)[\s\S]*synthetic_session_audit_failed/,
  "an unaudited synthetic session is cleared and fails closed");

for (const [name, value] of Object.entries(prior)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

console.log("Synthetic staging social authentication checks passed.");
