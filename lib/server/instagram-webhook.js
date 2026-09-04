import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const MAX_EVENTS = 1_000;
const MAX_EVENT_BYTES = 32_768;

const plainObject = (value) => value && !Array.isArray(value) && typeof value === "object";
const string = (value, maximum = 240) => typeof value === "string" && value.length <= maximum ? value : "";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const secureTokenEqual = (left, right) => {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length > 0 && first.length === second.length && timingSafeEqual(first, second);
};

export const verifyInstagramWebhookSignature = ({ rawBody, signature, appSecret }) => {
  if (!appSecret || !/^sha256=[0-9a-f]{64}$/i.test(signature || "")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const supplied = String(signature).slice(7).toLowerCase();
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
};

const providerTimestamp = (value, fallback) => {
  const input = Number(value ?? fallback);
  if (!Number.isFinite(input) || input <= 0) return null;
  const milliseconds = input > 10_000_000_000 ? input : input * 1_000;
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const explicitSaveCommand = (message) => {
  const text = string(message?.text, 2_000).trim();
  const match = text.match(/^save\s+(https:\/\/\S+)\s*$/i);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    url.username = "";
    url.password = "";
    return { name: "save", url: url.href };
  } catch {
    return null;
  }
};

const normalizedPayload = ({ entryId, kind, unit }) => {
  const payload = { professional_account_id: entryId, kind };
  const command = explicitSaveCommand(unit.message);
  if (command) payload.command = command;
  const objectId = string(unit.value?.id || unit.value?.media_id || unit.value?.comment_id, 240);
  if (objectId) payload.provider_object_id = objectId;
  const field = string(unit.field, 120);
  if (field) payload.field = field;
  return payload;
};

export const normalizeInstagramWebhook = (input) => {
  if (!plainObject(input) || input.object !== "instagram" || !Array.isArray(input.entry)) {
    throw new Error("INSTAGRAM_WEBHOOK_INVALID");
  }
  const events = [];
  for (const entry of input.entry) {
    if (!plainObject(entry)) throw new Error("INSTAGRAM_WEBHOOK_INVALID");
    const entryId = string(entry.id, 160);
    if (!entryId) throw new Error("INSTAGRAM_WEBHOOK_INVALID");
    const units = [
      ...(Array.isArray(entry.messaging) ? entry.messaging.map((unit) => ({ kind: "messaging", unit })) : []),
      ...(Array.isArray(entry.changes) ? entry.changes.map((unit) => ({ kind: "change", unit })) : [])
    ];
    for (const { kind, unit } of units) {
      if (!plainObject(unit)) throw new Error("INSTAGRAM_WEBHOOK_INVALID");
      const serialized = JSON.stringify(unit);
      if (Buffer.byteLength(serialized) > MAX_EVENT_BYTES) throw new Error("INSTAGRAM_WEBHOOK_EVENT_TOO_LARGE");
      const payloadHash = sha256(serialized);
      const providerId = string(unit.message?.mid || unit.postback?.mid || unit.value?.id, 200);
      const providerEventId = providerId || `sha256:${payloadHash}`;
      const eventType = kind === "messaging"
        ? unit.message ? (explicitSaveCommand(unit.message) ? "message.save" : "message.ignored")
          : unit.postback ? "postback" : unit.read ? "read" : "messaging.unknown"
        : `change.${string(unit.field, 100) || "unknown"}`;
      events.push({
        provider_event_id: providerEventId,
        professional_account_id: entryId,
        sender_id: string(unit.sender?.id, 160) || null,
        event_type: eventType,
        provider_timestamp: providerTimestamp(unit.timestamp, entry.time),
        payload_hash: payloadHash,
        payload: normalizedPayload({ entryId, kind, unit })
      });
      if (events.length > MAX_EVENTS) throw new Error("INSTAGRAM_WEBHOOK_BATCH_TOO_LARGE");
    }
  }
  return events;
};
