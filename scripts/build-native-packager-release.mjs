import fs from "node:fs";
import path from "node:path";
import { buildNativePackagerRelease, RELEASE_FILENAME } from "../src/native-packager-release.js";

const [directory, buildFile, optional] = process.argv.slice(2);
if (!directory || !buildFile || (optional && optional !== "--allow-unversioned") || process.argv.length > 5) throw new Error("Expected artifact directory, build-info JSON and optional --allow-unversioned");
const build = JSON.parse(fs.readFileSync(buildFile, "utf8"));
if (optional && (build.revision === "unknown" || build.builtAt === "unknown")) {
  process.stdout.write("SKIP release manifest: unversioned development build\n");
} else {
  fs.writeFileSync(path.join(directory, RELEASE_FILENAME), buildNativePackagerRelease(directory, build), { flag: "wx", mode: 0o644 });
}
