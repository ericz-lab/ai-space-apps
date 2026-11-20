/**
 * `bun scripts/add-publisher.ts ID "NAME" PUBLIC_KEY.pem [--url https://...]`: write
 * publishers/ID.json from an Ed25519 public key (`space app keygen --out key.pem` makes the pair and
 * prints the key ID). Only the public half ever comes here; the private key stays with the publisher.
 */
import { join, resolve } from "node:path";
import { keyIdOf, parsePublisher } from "./lib.ts";

const root = resolve(import.meta.dir, "..");
const [id, name, keyFile] = Bun.argv.slice(2);
const urlAt = Bun.argv.indexOf("--url");
const url = urlAt >= 0 ? Bun.argv[urlAt + 1] : undefined;
if (!id || !name || !keyFile) {
  console.error('usage: bun scripts/add-publisher.ts ID "NAME" PUBLIC_KEY.pem [--url https://...]');
  process.exit(2);
}
const publicKey = (await Bun.file(keyFile).text()).trim() + "\n";
if (publicKey.includes("PRIVATE KEY")) throw new Error(`${keyFile} is a private key: give the public one (.pub)`);
const publisher = parsePublisher({ id, name, ...(url ? { url } : {}), keyId: keyIdOf(publicKey), publicKey }, `publishers/${id}.json`);
await Bun.write(join(root, "publishers", `${id}.json`), JSON.stringify(publisher, null, 2) + "\n");
console.log(`publishers/${id}.json: key ${publisher.keyId}`);
