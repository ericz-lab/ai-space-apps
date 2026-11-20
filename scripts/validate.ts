/**
 * `bun scripts/validate.ts [--fetch] [CATALOG]`: check a catalog (default: ./catalog.json) the way
 * a Space reads it. With `--fetch`, also download every released package and check that its
 * SHA-256 is the catalog's, that it is the app and version the entry says, and that it is signed
 * by the entry's publisher. Icons and repositories are fetched too.
 */
import { resolve } from "node:path";
import { parseCatalog, readPackage, sha256 } from "./lib.ts";

const args = Bun.argv.slice(2);
const fetching = args.includes("--fetch");
const path = resolve(args.find((a) => !a.startsWith("--")) ?? "catalog.json");
const base = process.env.CATALOG_BASE_URL ?? "https://raw.githubusercontent.com/ericz-lab/ai-space-apps/main/catalog.json";
const catalog = parseCatalog(await Bun.file(path).json());
console.log(`${path}: format 1, ${catalog.publishers.length} publishers, ${catalog.apps.length} apps`);
if (!fetching) process.exit(0);

let failed = 0;
const fail = (msg: string) => { failed++; console.error(`  ✗ ${msg}`); };
for (const app of catalog.apps) {
  console.log(app.name);
  const publisher = catalog.publishers.find((p) => p.id === app.publisher)!;
  const repo = await fetch(app.repo, { method: "HEAD", redirect: "follow" }).catch(() => undefined);
  if (!repo?.ok) fail(`repository ${app.repo} does not answer`);
  if (app.icon) {
    const icon = await fetch(new URL(app.icon, base), { method: "HEAD" }).catch(() => undefined);
    if (!icon?.ok) fail(`icon ${app.icon} does not answer`);
  }
  if (!app.latest) { console.log("  no release yet"); continue; }
  for (const [variant, pkg] of [["package", app.latest.package], ["sourcePackage", app.latest.sourcePackage]] as const) {
    if (!pkg) continue;
    const url = new URL(pkg.url, base);
    const res = await fetch(url, { redirect: "follow" }).catch((e) => e as Error);
    if (res instanceof Error || !res.ok) { fail(`${variant}: ${url} could not be downloaded`); continue; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sha256(bytes) !== pkg.sha256) { fail(`${variant}: sha256 is ${sha256(bytes)}, the catalog says ${pkg.sha256}`); continue; }
    try {
      const p = readPackage(bytes, publisher.publicKey);
      if (p.name !== app.name || p.version !== app.latest.version) fail(`${variant}: the package is ${p.name} ${p.version}, the entry says ${app.name} ${app.latest.version}`);
      if (p.signature !== "verified") fail(`${variant}: not signed by ${publisher.name} (${p.signature}${p.keyId ? `, key ${p.keyId}` : ""})`);
      if (variant === "sourcePackage" && !p.sourceIncluded) fail(`${variant}: the package does not include its source`);
      if (p.signature === "verified") console.log(`  ${variant} ${p.version}: sha256 and signature ok`);
    } catch (e) { fail(`${variant}: ${(e as Error).message}`); }
  }
}
if (failed) { console.error(`${failed} problem(s)`); process.exit(1); }
