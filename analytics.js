const eventNames = new Set([
  "page_view",
  "discovery_saved",
  "discovery_unsaved",
  "discovery_sponsored",
  "discovery_filter_changed",
  "work_filter_changed",
  "work_viewed",
  "curator_viewed",
  "exhibition_viewed",
  "bazaar_viewed",
  "calendar_saved",
  "join_started",
  "join_unavailable",
  "join_completed",
  "join_cancelled",
  "draft_started",
  "draft_reviewed",
  "acquisition_preview_opened",
  "acquisition_method_changed",
  "client_error"
]);

const privacyDisabled = navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true;
let configurationRequest;

const sessionId = () => {
  try {
    const current = sessionStorage.getItem("brooklyn_marketplace_session_id");
    if (current) return current;
    const created = crypto.randomUUID();
    sessionStorage.setItem("brooklyn_marketplace_session_id", created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
};

const metricsEnabled = async () => {
  if (privacyDisabled) return false;
  if (!configurationRequest) {
    configurationRequest = fetch("/api/config", { headers: { Accept: "application/json" } })
      .then(async (response) => response.ok ? response.json() : null)
      .then((configuration) => Boolean(configuration?.metrics?.configured))
      .catch(() => false);
  }
  return configurationRequest;
};

export const track = async (eventName, {
  route = "home",
  entityType = null,
  entityId = null,
  properties = {}
} = {}) => {
  if (!eventNames.has(eventName) || !(await metricsEnabled())) return;

  const body = {
    event_name: eventName,
    client_timestamp: new Date().toISOString(),
    session_id: sessionId(),
    route,
    entity_type: entityType,
    entity_id: entityId,
    properties
  };

  void fetch("/api/events", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).catch(() => {});
};

export const trackClientErrors = (routeName) => {
  addEventListener("error", () => void track("client_error", { route: routeName(), properties: { kind: "error" } }));
  addEventListener("unhandledrejection", () => void track("client_error", { route: routeName(), properties: { kind: "unhandledrejection" } }));
};
