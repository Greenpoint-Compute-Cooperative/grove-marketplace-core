import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist");
if (!output.startsWith(`${root}${sep}`)) throw new Error("Unsafe output path");

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "public"), { recursive: true });

for (const file of ["index.html", "auction-terms.html", "app.js", "analytics.js", "catalog.js", "styles.css", "manifest.webmanifest", "robots.txt", "sitemap.xml", "THIRD_PARTY_NOTICES.md"]) {
  await copyFile(join(root, file), join(output, file));
}

await cp(join(root, "public", "assets"), join(output, "public", "assets"), { recursive: true });
await cp(join(root, "public", "metadata"), join(output, "public", "metadata"), { recursive: true });
await mkdir(join(output, ".well-known"), { recursive: true });
await copyFile(join(root, "public", ".well-known", "security.txt"), join(output, ".well-known", "security.txt"));
const buildResult = await build({
  entryPoints: [join(root, "lib", "browser", "wallet-intents.js")],
  outfile: join(output, "wallet-intents.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  metafile: true
});

const bundledPackages = [...new Set(Object.keys(buildResult.metafile.inputs).flatMap((input) => {
  const match = input.replaceAll("\\", "/").match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  return match ? [match[1]] : [];
}))].sort();
const noticeSections = [
  "THIRD-PARTY SOFTWARE NOTICES",
  "",
  "The following license texts cover every package contributing code to wallet-intents.js.",
  "The list is generated from the esbuild metafile on every release build."
];
for (const packageName of bundledPackages) {
  const packageRoot = join(root, "node_modules", ...packageName.split("/"));
  const packageMetadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  let licenseText = null;
  for (const candidate of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE-MIT", "COPYING"]) {
    const candidatePath = join(packageRoot, candidate);
    try {
      await access(candidatePath);
      licenseText = await readFile(candidatePath, "utf8");
      break;
    } catch {
      // Try the next conventional license filename.
    }
  }
  if (!licenseText) {
    const vendoredLicensePath = join(root, "third_party_licenses", `${packageName.replaceAll("/", "__")}.LICENSE`);
    try {
      await access(vendoredLicensePath);
      licenseText = await readFile(vendoredLicensePath, "utf8");
    } catch {
      // The build fails below unless a reviewed license text is present.
    }
  }
  if (!licenseText) throw new Error(`Bundled package ${packageName} has no distributable license text`);
  noticeSections.push(
    "",
    "=".repeat(72),
    `${packageMetadata.name}@${packageMetadata.version} — ${packageMetadata.license || "license in package"}`,
    "=".repeat(72),
    "",
    licenseText.trim()
  );
}
await writeFile(join(output, "THIRD_PARTY_NOTICES.txt"), `${noticeSections.join("\n")}\n`, "utf8");
console.log("Static storefront built in dist/.");
