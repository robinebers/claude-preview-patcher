import { spawnSync } from "node:child_process";

import { PatcherError } from "./errors.js";

export function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });

  if (result.error) {
    throw new PatcherError(
      "COMMAND_FAILED",
      `Could not run ${executable}: ${result.error.message}`,
      { cause: result.error }
    );
  }

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const combinedOutput = [stdout, stderr].filter(Boolean).join("\n");

  if (result.status !== 0) {
    const command = [executable, ...args].join(" ");
    throw new PatcherError(
      "COMMAND_FAILED",
      `${command} failed${combinedOutput ? `:\n${combinedOutput}` : "."}`
    );
  }

  return { stdout, stderr, combinedOutput };
}
