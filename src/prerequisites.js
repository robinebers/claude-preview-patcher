import { accessSync, constants, existsSync } from "node:fs";
import process from "node:process";

import { PatcherError, invariant } from "./errors.js";

export const tools = Object.freeze({
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  open: "/usr/bin/open",
  plutil: "/usr/bin/plutil",
  ps: "/bin/ps",
  xattr: "/usr/bin/xattr",
});

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function checkPrerequisites({ needsOpen = false } = {}) {
  invariant(
    process.platform === "darwin",
    "UNSUPPORTED_PLATFORM",
    "This patcher only supports macOS."
  );

  const majorVersion = Number.parseInt(process.versions.node.split(".")[0], 10);
  invariant(
    Number.isInteger(majorVersion) && majorVersion >= 20,
    "UNSUPPORTED_NODE",
    `Node.js 20 or newer is required; found ${process.versions.node}. Install a current Node.js release, then run the npx command again.`
  );

  const requiredNames = ["codesign", "ditto", "plutil", "ps", "xattr"];
  if (needsOpen) {
    requiredNames.push("open");
  }
  const missing = requiredNames.filter(
    (name) => !existsSync(tools[name]) || !isExecutable(tools[name])
  );
  if (missing.length > 0) {
    throw new PatcherError(
      "MISSING_SYSTEM_TOOL",
      `This Mac is missing required system tools: ${missing.join(", ")}. Install available macOS updates; the patcher will not install or replace system software.`
    );
  }

  return {
    nodeVersion: process.versions.node,
    tools: requiredNames.map((name) => ({ name, path: tools[name] })),
  };
}

export function formatPrerequisites(result) {
  const lines = [`[ok] Node.js ${result.nodeVersion}`];
  lines.push(`[ok] Required macOS tools (${result.tools.map(({ name }) => name).join(", ")})`);
  lines.push("[ok] No third-party runtime dependencies");
  return lines.join("\n");
}
