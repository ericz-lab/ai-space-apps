/**
 * `bun scripts/release-entry.ts APP --tag vX.Y.Z --package FILE [--source-package FILE] --base-url URL`
 *
 * Point apps/APP.json's `latest` at a release: reads each `.spaceapp` (built by
 * `space app release`), checks it is APP at the tag's version and signed by APP's publisher, and
 * writes its SHA-256 and download URL (`URL/<file name>`, the GitHub release's download
 * directory). Then run scripts/build.ts. An app's release workflow runs this and opens the pull request.
 */
import { basename, join, resolve } from "node:path";
import { parseApp, parsePublisher, readPackage, sha256 } from "./lib.ts";

const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const app = args[0];
const tag = flag("--tag"), packageFile = flag("--package"), sourceFile = flag("--source-package"), baseUrl = flag("--base-url");
if (!app || !tag || !packageFile || !baseUrl) {
  console.error("usage: bun scripts/release-entry.ts APP --tag vX.Y.Z --package FILE [--source-package FILE] --base-url https://github.com/OWNER/REPO/releases/download/vX.Y.Z");
  process.exit(2);
}
if (!/^https:\/\//.test(baseUrl)) throw new Error("--base-url must be https");
const entryFile = join(root, "apps", `${app}.json`);
const entry = await Bun.file(entryFile).json() as Record<string, unknown>;
const publisher = parsePublisher(await Bun.file(join(root, "publishers", `${entry.publisher}.json`)).json(), `publishers/${entry.publisher}.json`);
const version = tag.replace(/^v/, "");

const describe = async (file: string, wantSource: boolean) => {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const p = readPackage(bytes, publisher.publicKey);
  if (p.name !== app || p.version !== version) throw new Error(`${file} is ${p.name} ${p.version}, not ${app} ${version}`);
  if (p.signature !== "verified") throw new Error(`${file} is not signed by ${publisher.name} (${p.signature})`);
  if (wantSource && !p.sourceIncluded) throw new Error(`${file} does not include its source`);
  return { url: `${baseUrl.replace(/\/$/, "")}/${basename(file)}`, sha256: sha256(bytes), requires: p.requires };
};
const main = await describe(packageFile, false);
const source = sourceFile ? await describe(sourceFile, true) : undefined;
const latest = {
  version, tag,
  package: { url: main.url, sha256: main.sha256 },
  ...(source ? { sourcePackage: { url: source.url, sha256: source.sha256 } } : {}),
  requires: main.requires,
};
const next = { ...entry, latest };
parseApp(next, `apps/${app}.json`, new Set([publisher.id]));
await Bun.write(entryFile, JSON.stringify(next, null, 2) + "\n");
console.log(`apps/${app}.json → ${version}`);
