import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { keyIdOf, parseCatalog, readPackage } from "./lib.ts";

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, pem, keyId: keyIdOf(pem) };
}

/** A minimal USTAR + gzip, the outer layout of a `.spaceapp`. */
function tar(files: Record<string, string | Uint8Array>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "ascii");
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const catalog = (k: ReturnType<typeof keys>, app: Record<string, unknown> = {}) => ({
  catalog: 1,
  publishers: [{ id: "lab", name: "Lab", keyId: k.keyId, publicKey: k.pem }],
  apps: [{ name: "notes", publisher: "lab", title: { en: "Notes", zh: "笔记" }, description: "Short notes", repo: "https://github.com/example/notes", license: "MIT", needs: ["model"], ...app }],
});

test("a valid catalog parses; the Space's rules reject the rest", () => {
  const k = keys();
  expect(parseCatalog(catalog(k)).apps[0]).toMatchObject({ name: "notes", recommended: false, needs: ["model"] });
  expect(() => parseCatalog(catalog(k, { needs: ["unknown-thing"] }))).toThrow(/not one of/);
  expect(() => parseCatalog(catalog(k, { publisher: "nobody" }))).toThrow(/publisher/);
  expect(() => parseCatalog(catalog(k, { repo: "http://example.com" }))).toThrow(/https/);
  expect(() => parseCatalog(catalog(k, { latest: { version: "1", tag: "v1", package: { url: "x", sha256: "0".repeat(64) }, requires: { spaceApi: 1 } } }))).toThrow(/major.minor.patch/);
  const wrongKey = catalog(k);
  wrongKey.publishers[0]!.keyId = keys().keyId;
  expect(() => parseCatalog(wrongKey)).toThrow(/does not match/);
});

test("a package's name, version, source flag and signature are read without extracting it", () => {
  const k = keys();
  const index = JSON.stringify({ format: 1, target: { os: "any", arch: "any" }, sourceIncluded: true, files: [] });
  const sig = JSON.stringify({ algorithm: "ed25519", keyId: k.keyId, signature: sign(null, Buffer.from(index), k.privateKey).toString("base64") });
  const bytes = tar({ "package.json": index, "package.sig": sig, "app/space.yaml": "spec: 2\nname: notes\nversion: 1.2.0\nrequires: { spaceApi: 1, bun: 1.3.0 }\n" });
  expect(readPackage(bytes, k.pem)).toEqual({ name: "notes", version: "1.2.0", requires: { spaceApi: 1, bun: "1.3.0" }, sourceIncluded: true, keyId: k.keyId, signature: "verified" });
  expect(readPackage(bytes, keys().pem).signature).toBe("untrusted");
  const forged = tar({ "package.json": index.replace("true", "false"), "package.sig": sig, "app/space.yaml": "name: notes\nversion: 1.2.0\n" });
  expect(() => readPackage(forged, k.pem)).toThrow(/does not verify/);
  expect(readPackage(tar({ "package.json": index, "app/space.yaml": "name: notes\nversion: 1.2.0\n" })).signature).toBe("unsigned");
});
