import { posixPackagerUpdater } from "./native-packager-posix-updater.js";

// Inputs originate in the validated installer contract, never a remote command.
export function linuxPackagerUpdater(input) {
  return posixPackagerUpdater({ ...input, platform: "linux" });
}
