import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 8013);
const host = process.env.HOST || "127.0.0.1";
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

const resolvePath = (pathname) => {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const normalized = normalize(requested);
  const rootFiles = ["index.html", "auction-terms.html", "app.js", "analytics.js", "catalog.js", "styles.css", "manifest.webmanifest", "robots.txt", "sitemap.xml", "wallet-intents.js"];
  const allowedRootFile = rootFiles.includes(normalized);
  const allowedAsset = normalized.startsWith(`public${sep}assets${sep}`);
  const allowedMetadata = normalized.startsWith(`public${sep}metadata${sep}`);
  if (normalized === join(".well-known", "security.txt")) return join(root, "public", normalized);
  if (normalized.includes("..") || (!allowedRootFile && !allowedAsset && !allowedMetadata)) return null;
  return normalized === "wallet-intents.js" ? join(root, "dist", normalized) : join(root, normalized);
};

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname;
  const filePath = resolvePath(pathname);
  if (!filePath) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("NOT_FILE");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": info.size,
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, host, () => console.log(`Marketplace is available at http://${host}:${port}`));
