export const json = (body, { status = 200, headers } = {}) => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
};

export const problem = (status, code, message, headers) => json(
  { error: { code, message } },
  { status, headers }
);

export const redirect = (location, { status = 303, headers } = {}) => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Location", location);
  return new Response(null, { status, headers: responseHeaders });
};

export const readJson = async (request, maximumBytes = 12_000) => {
  const announcedLength = Number(request.headers.get("content-length") || 0);
  if (announcedLength > maximumBytes) throw new Error("PAYLOAD_TOO_LARGE");

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) throw new Error("PAYLOAD_TOO_LARGE");
  try {
    const body = JSON.parse(raw || "{}");
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("INVALID_JSON");
    return body;
  } catch (error) {
    if (error.message === "PAYLOAD_TOO_LARGE") throw error;
    throw new Error("INVALID_JSON");
  }
};

export const text = (input, { maximum = 500, required = false } = {}) => {
  const output = typeof input === "string" ? input.trim() : "";
  if (required && !output) throw new Error("INVALID_INPUT");
  if (output.length > maximum) throw new Error("INVALID_INPUT");
  return output || null;
};

export const publicUrl = (input) => {
  const candidate = text(input, { required: true, maximum: 2_000 });
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("INVALID_INPUT");
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    throw new Error("INVALID_INPUT");
  }
};

export const requestFailure = (error, headers) => {
  if (error.message === "PAYLOAD_TOO_LARGE") return problem(413, "payload_too_large", "The request is too large.", headers);
  if (error.message === "INVALID_JSON") return problem(400, "invalid_json", "Send a JSON object.", headers);
  if (error.message === "INVALID_INPUT") return problem(422, "invalid_input", "Check the submitted fields.", headers);
  return null;
};
