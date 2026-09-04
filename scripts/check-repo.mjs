import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
assert.ok(paths.length > 100, "Expected the complete tracked source release.");
for (const path of paths) {
  assert.ok(!/(?:^|\/)(?:\.sepolia|\.local|\.vercel|inventories|environments|ansible)(?:\/|$)/.test(path), `Operator files forbidden: ${path}`);
  assert.ok(!/(?:\.keystore|\.pem|\.key|\.p12|\.pfx|\.dump|\.jpg|\.png|\.glb)$/.test(path), `Unreviewed private/binary artifact: ${path}`);
  assert.ok(!/(?:^|\/)\.env(?:\.|$)/.test(path) || path === ".env.example", `Only blank example env files are allowed: ${path}`);
  if (path === "contracts/lib/forge-std") continue;
  const text = await readFile(join(root, path), "utf8");
  assert.ok(!/[a-z0-9-]+\.vercel\.app/.test(text), `Real deployment host found: ${path}`);
  if (path.startsWith(".github/workflows/")) {
    assert.doesNotMatch(text, /secrets\.|pull_request_target|id-token:\s*write|contents:\s*write/, "Public CI may not receive credentials or write permissions.");
    assert.doesNotMatch(text, /uses:\s+[^\s]+@(v\d+|main|master)\b/, "Pin actions to immutable commits.");
  }
}
for (const path of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "docs/ENVIRONMENTS.md", "docs/STRIPE_LAUNCH.md", "PUBLIC_FILES.sha256.json", "PUBLIC_SUBMODULES.json"]) {
  assert.ok((await readFile(join(root, path), "utf8")).trim(), `${path} required`);
}
assert.equal(JSON.parse(await readFile(join(root, "vercel.json"), "utf8")).crons, undefined, "Active schedules belong in private operations.");
console.log(`Public boundary checks passed for ${paths.length} tracked files.`);
