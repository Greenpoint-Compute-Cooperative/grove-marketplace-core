import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const helper = app.match(/const optimizedImageUrl = ([^\n]+);/)[1];
const optimize = vm.runInNewContext(`(${helper})`);
assert.equal(optimize("/public/assets/physical-works.svg", 750, 75), "/public/assets/physical-works.svg", "Original local SVG demo bypasses raster optimizer");
assert.match(optimize("/public/assets/rights-cleared.jpg", 750, 75), /^\/_vercel\/image\?/, "Rights-cleared raster optimization is retained");
assert.match(app, /\$\{sheet\}-works\.svg/, "Dynamic demo sheets reference existing SVG files");
const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
assert.equal(config.images.dangerouslyAllowSVG, false, "Never enable remote SVG optimization for demo placeholders");
const server = await readFile(new URL("../scripts/serve-static.mjs", import.meta.url), "utf8");
assert.match(server, /"\.svg": "image\/svg\+xml"/, "Local nosniff responses declare SVG image content type");
console.log("Public export media checks passed.");
