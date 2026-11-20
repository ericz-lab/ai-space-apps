import { createHash, createPublicKey, verify } from "node:crypto";
import { gunzipSync } from "node:zlib";

/**
 * The catalog format ai-space reads (format 1; ai-space src/space/packages/app-catalog.ts and
 * docs/app-catalog.md). These checks mirror the Space's own: a catalog that passes here is one a
 * Space accepts. Unknown keys are allowed so the format can grow; every known key is checked.
 */

export type Localized = { en: string; zh?: string };
export type Pkg = { url: string; sha256: string };
export type Release = { version: string; tag: string; package: Pkg; sourcePackage?: Pkg; requires: { spaceApi: number; bun?: string } };
export type Publisher = { id: string; name: string; keyId: string; publicKey: string; url?: string };
export type App = { name: string; publisher: string; title: Localized; description: Localized; icon?: string; repo: string; license: string; recommended?: boolean; needs?: string[]; online?: Localized[]; latest?: Release };
export type Catalog = { catalog: 1; publishers: Publisher[]; apps: App[] };

/** What an app may say it needs; the panel explains each one before installing. */
export const NEEDS = ["model", "agent-logs", "operator", "s3", "git"] as const;

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function obj(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  return raw as Record<string, unknown>;
}
function str(raw: unknown, where: string, max = 300): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(raw)) throw new Error(`${where} must be a non-empty string of at most ${max} characters`);
  return raw;
}
function list(raw: unknown, where: string, max: number): unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > max) throw new Error(`${where} must be a list of at most ${max}`);
  return raw;
}
function localized(raw: unknown, where: string, max = 300): Localized {
  if (typeof raw === "string") return { en: str(raw, where, max) };
  const o = obj(raw, where);
  return { en: str(o.en, `${where}.en`, max), ...(o.zh === undefined ? {} : { zh: str(o.zh, `${where}.zh`, max) }) };
}
function location(raw: unknown, where: string): string {
  const value = str(raw, where, 2048);
  const url = new URL(value, "https://catalog.invalid/");
  if (url.username || url.password || url.protocol !== "https:") throw new Error(`${where} must be an https URL or a path relative to the catalog`);
  return value;
}
function pkg(raw: unknown, where: string): Pkg {
  const o = obj(raw, where);
  const digest = str(o.sha256, `${where}.sha256`, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${where}.sha256 must be a lowercase SHA-256 digest`);
  return { url: location(o.url, `${where}.url`), sha256: digest };
}
function version(raw: unknown, where: string): string {
  if (typeof raw !== "string" || !VERSION.test(raw)) throw new Error(`${where} must be a numeric major.minor.patch`);
  return raw;
}

export function keyIdOf(pem: string): string {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("publisher keys are Ed25519");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

export function parsePublisher(raw: unknown, where: string): Publisher {
  const p = obj(raw, where);
  const id = str(p.id, `${where}.id`, 64);
  if (!NAME.test(id)) throw new Error(`${where}.id is not a valid id`);
  const publicKey = str(p.publicKey, `${where}.publicKey`, 1024);
  const keyId = str(p.keyId, `${where}.keyId`, 64);
  let actual: string;
  try { actual = keyIdOf(publicKey); } catch { throw new Error(`${where}.publicKey is not an Ed25519 public key`); }
  if (actual !== keyId) throw new Error(`${where}.keyId does not match its public key`);
  return { id, name: str(p.name, `${where}.name`, 100), keyId, publicKey, ...(p.url === undefined ? {} : { url: location(p.url, `${where}.url`) }) };
}

export function parseApp(raw: unknown, where: string, publishers: Set<string>): App {
  const a = obj(raw, where);
  const name = str(a.name, `${where}.name`, 64);
  if (!NAME.test(name) || name === "space") throw new Error(`${where}.name is not a valid app name`);
  const publisher = str(a.publisher, `${where}.publisher`, 64);
  if (!publishers.has(publisher)) throw new Error(`${where}.publisher names no publisher of this catalog`);
  const repo = str(a.repo, `${where}.repo`, 500);
  if (!/^https:\/\/[^\s@]+$/.test(repo)) throw new Error(`${where}.repo must be an https URL`);
  const needs = list(a.needs, `${where}.needs`, 20).map((n, j) => {
    if (typeof n !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(n)) throw new Error(`${where}.needs[${j}] must be a lowercase word`);
    if (!(NEEDS as readonly string[]).includes(n)) throw new Error(`${where}.needs[${j}]: ${n} is not one of ${NEEDS.join(", ")} (add it to scripts/lib.ts and the Space's panel first)`);
    return n;
  });
  if (a.recommended !== undefined && typeof a.recommended !== "boolean") throw new Error(`${where}.recommended must be true or false`);
  let latest: Release | undefined;
  if (a.latest !== undefined && a.latest !== null) {
    const l = obj(a.latest, `${where}.latest`);
    const r = obj(l.requires, `${where}.latest.requires`);
    const tag = str(l.tag, `${where}.latest.tag`, 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tag)) throw new Error(`${where}.latest.tag is not a valid tag`);
    if (typeof r.spaceApi !== "number" || !Number.isSafeInteger(r.spaceApi) || r.spaceApi < 1) throw new Error(`${where}.latest.requires.spaceApi must be a positive integer`);
    latest = {
      version: version(l.version, `${where}.latest.version`), tag, package: pkg(l.package, `${where}.latest.package`),
      ...(l.sourcePackage === undefined ? {} : { sourcePackage: pkg(l.sourcePackage, `${where}.latest.sourcePackage`) }),
      requires: { spaceApi: r.spaceApi, ...(r.bun === undefined ? {} : { bun: version(r.bun, `${where}.latest.requires.bun`) }) },
    };
  }
  return {
    name, publisher, title: localized(a.title, `${where}.title`, 100), description: localized(a.description, `${where}.description`, 1000),
    ...(a.icon === undefined ? {} : { icon: location(a.icon, `${where}.icon`) }), repo, license: str(a.license, `${where}.license`, 64),
    recommended: a.recommended === true, needs, online: list(a.online, `${where}.online`, 20).map((o, j) => localized(o, `${where}.online[${j}]`)),
    ...(latest ? { latest } : {}),
  };
}

export function parseCatalog(raw: unknown): Catalog {
  const doc = obj(raw, "catalog");
  if (doc.catalog !== 1) throw new Error("catalog must be format 1");
  const publishers = list(doc.publishers, "publishers", 200).map((p, i) => parsePublisher(p, `publishers[${i}]`));
  const ids = new Set(publishers.map((p) => p.id));
  if (ids.size !== publishers.length) throw new Error("publisher ids must be unique");
  const names = new Set<string>();
  const apps = list(doc.apps, "apps", 1000).map((a, i) => {
    const app = parseApp(a, `apps[${i}]`, ids);
    if (names.has(app.name)) throw new Error(`apps[${i}]: ${app.name} is listed twice`);
    names.add(app.name);
    return app;
  });
  return { catalog: 1, publishers, apps };
}

/**
 * What a `.spaceapp` says about itself, read without extracting it: the package index, the
 * manifest's name and version, and the detached signature checked against `publicKey`.
 * The full checks (every file's digest, the manifest's contract) are the Space's own:
 * `space app inspect-package FILE --trusted-key KEY`.
 */
export type PackageFacts = { name: string; version: string; requires: { spaceApi: number; bun?: string }; sourceIncluded: boolean; keyId?: string; signature: "unsigned" | "verified" | "untrusted" };
export function readPackage(bytes: Uint8Array, publicKey?: string): PackageFacts {
  const tar = gunzipSync(bytes);
  const files = new Map<string, Uint8Array>();
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, len: number) => new TextDecoder().decode(header.subarray(from, from + len)).replace(/\0.*$/s, "");
    const name = (field(345, 155) ? field(345, 155) + "/" : "") + field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    files.set(name, tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  const index = files.get("package.json");
  const yaml = files.get("app/space.yaml");
  if (!index || !yaml) throw new Error("not an ai-space package: package.json or app/space.yaml is missing");
  const manifest = Bun.YAML.parse(new TextDecoder().decode(yaml)) as { name?: unknown; version?: unknown; requires?: { spaceApi?: number; bun?: string } };
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") throw new Error("the package manifest has no name or version");
  const meta = JSON.parse(new TextDecoder().decode(index)) as { sourceIncluded?: boolean };
  const sig = files.get("package.sig");
  const requires = { spaceApi: manifest.requires?.spaceApi ?? 1, ...(manifest.requires?.bun ? { bun: manifest.requires.bun } : {}) };
  const base = { name: manifest.name, version: manifest.version, requires, sourceIncluded: meta.sourceIncluded === true };
  if (!sig) return { ...base, signature: "unsigned" };
  const envelope = JSON.parse(new TextDecoder().decode(sig)) as { algorithm: string; keyId: string; signature: string };
  if (!publicKey || keyIdOf(publicKey) !== envelope.keyId) return { ...base, keyId: envelope.keyId, signature: "untrusted" };
  if (!verify(null, index, createPublicKey(publicKey), Buffer.from(envelope.signature, "base64"))) throw new Error("the package signature does not verify");
  return { ...base, keyId: envelope.keyId, signature: "verified" };
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
