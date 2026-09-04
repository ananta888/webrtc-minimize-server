import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const filename = path.resolve(process.argv[2] || ".deploy/secrets/broadcast-signing-private-key.pem");
const directory = path.dirname(filename);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const parent = fs.lstatSync(directory);
if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("broadcast signing-key directory is unsafe");

if (!fs.existsSync(filename)) {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const descriptor = fs.openSync(filename, "wx", 0o600);
  try { fs.writeFileSync(descriptor, pem); } finally { fs.closeSync(descriptor); }
}

const info = fs.lstatSync(filename);
if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 16 * 1024) {
  throw new Error("broadcast signing key permissions are unsafe");
}
const key = crypto.createPrivateKey(fs.readFileSync(filename));
if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
  throw new Error("broadcast signing key must be P-256");
}
process.stdout.write("Broadcast signing key is present and permission-bounded.\n");
