/**
 * `bun scripts/build.ts [--check]`: publishers/*.json and apps/*.json → catalog.json, the file every
 * Space reads. Each app and publisher keeps its own file so that pull requests do not collide.
 * An app whose publisher has no file yet is left out (and said so). `--check` fails when
 * catalog.json is not what the sources make, as CI runs it.
 */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseApp, parseCatalog, parsePublisher, type Catalog } from "./lib.ts";

const root = resolve(import.meta.dir, "..");
const check = Bun.argv.includes("--check");

async function readDir(dir: string): Promise<{ file: string; data: unknown }[]> {
  const names = (await readdir(join(root, dir)).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
  return Promise.all(names.map(async (n) => ({ file: `${dir}/${n}`, data: await Bun.file(join(root, dir, n)).json() })));
}

const publishers = (await readDir("publishers")).map(({ file, data }) => {
  const p = parsePublisher(data, file);
  if (`publishers/${p.id}.json` !== file) throw new Error(`${file} must be named after its id (${p.id}.json)`);
  return p;
});
const ids = new Set(publishers.map((p) => p.id));
const apps = [];
for (const { file, data } of await readDir("apps")) {
  const publisher = (data as { publisher?: unknown }).publisher;
  if (typeof publisher === "string" && !ids.has(publisher)) {
    parseApp(data, file, new Set([publisher])); // still checked, so a mistake shows before the key arrives
    console.error(`${file}: left out until publishers/${publisher}.json exists`);
    continue;
  }
  const app = parseApp(data, file, ids);
  if (`apps/${app.name}.json` !== file) throw new Error(`${file} must be named after its app (${app.name}.json)`);
  if (app.icon && !/^https:/.test(app.icon) && !(await Bun.file(join(root, app.icon)).exists())) throw new Error(`${file}: icon ${app.icon} is not in this repository`);
  apps.push(data as Catalog["apps"][number]);
}
// Recommended first, then by name: the order the panel shows.
apps.sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true) || a.name.localeCompare(b.name));
const catalog = { catalog: 1, publishers: publishers.map(({ id, name, url, keyId, publicKey }) => ({ id, name, ...(url ? { url } : {}), keyId, publicKey })), apps };
parseCatalog(catalog);
const text = JSON.stringify(catalog, null, 2) + "\n";
const current = await Bun.file(join(root, "catalog.json")).text().catch(() => "");
if (check) {
  if (current !== text) {
    console.error("catalog.json is not what publishers/ and apps/ make: run bun scripts/build.ts and commit it");
    process.exit(1);
  }
  console.log(`catalog.json is current: ${publishers.length} publishers, ${apps.length} apps`);
} else {
  await Bun.write(join(root, "catalog.json"), text);
  console.log(`catalog.json: ${publishers.length} publishers, ${apps.length} apps`);
}
