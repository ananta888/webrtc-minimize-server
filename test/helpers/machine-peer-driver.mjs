// The Python-owned sandbox uses its installed Playwright 1.58 driver. A 1.62
// remote client cannot speak that server's protocol; never downgrade app deps.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export function peerBrowserDriver(packagePath) {
  try {
    if (typeof packagePath !== "string" || !path.isAbsolute(packagePath) || packagePath.length > 1024) throw new Error();
    const metadataPath = path.join(packagePath, "package.json"), stat = fs.statSync(metadataPath);
    if (!stat.isFile() || stat.size > 8192) throw new Error();
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (metadata.name !== "playwright-core" || metadata.version !== "1.58.0") throw new Error();
    return createRequire(import.meta.url)(packagePath).chromium;
  } catch { throw new Error("test_peer_browser_driver_invalid"); }
}
