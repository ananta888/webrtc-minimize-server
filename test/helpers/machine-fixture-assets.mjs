import fs from "node:fs/promises";
import path from "node:path";

// Test-runner input only, never a request parameter or production setting.
// Selecting a missing/partial build must not silently serve stale default assets.
export async function machineFixtureAssets(publicDir) {
  if (publicDir === undefined) return undefined;
  try {
    if (typeof publicDir !== "string" || !path.isAbsolute(publicDir)) throw new Error();
    const root = await fs.realpath(publicDir);
    if (!(await fs.stat(root)).isDirectory()) throw new Error();
    async function regularFile(name) {
      const file = await fs.realpath(path.join(root, name));
      if (path.dirname(file) !== root || !(await fs.stat(file)).isFile()) throw new Error();
      return file;
    }
    const index = await regularFile("index.html");
    if ((await fs.stat(index)).size > 1024 * 1024) throw new Error();
    const html = await fs.readFile(index, "utf8");
    // Angular production index: hashed, flat, local JS entry points.
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)];
    if (!scripts.length) throw new Error();
    for (const [, src] of scripts) {
      if (!/^(?:\.\/)?[a-zA-Z0-9_-]+\.js$/.test(src)) throw new Error();
      await regularFile(src);
    }
    return root;
  } catch {
    // No local paths or HTML in stdio bridge error reports.
    throw new Error("test_public_dir_invalid");
  }
}
