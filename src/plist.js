import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { runCommand } from "./command.js";
import { PatcherError, invariant } from "./errors.js";
import { tools } from "./prerequisites.js";

export const SOURCE_ASAR_HASH_KEY = "ClaudePreviewPatcherSourceASARHeaderHash";

export function readPlist(path) {
  let output;
  try {
    output = runCommand(tools.plutil, ["-convert", "json", "-o", "-", path]).stdout;
  } catch (error) {
    throw new PatcherError("INVALID_PLIST", `Could not read ${path} as a property list.`, {
      cause: error,
    });
  }

  try {
    const value = JSON.parse(output);
    invariant(
      value && typeof value === "object" && !Array.isArray(value),
      "INVALID_PLIST",
      `${path} does not contain a property-list dictionary.`
    );
    return value;
  } catch (error) {
    if (error instanceof PatcherError) {
      throw error;
    }
    throw new PatcherError("INVALID_PLIST", `${path} contains invalid property-list data.`, {
      cause: error,
    });
  }
}

export function serializePlist(value, destination, format = "xml1") {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "claude-preview-plist-"));
  const jsonPath = join(temporaryDirectory, "input.json");
  try {
    writeFileSync(jsonPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    runCommand(tools.plutil, ["-convert", format, "-o", destination, jsonPath]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function writePlistAtomically(path, value) {
  const original = readFileSync(path);
  const format = original.subarray(0, 8).toString("ascii") === "bplist00"
    ? "binary1"
    : "xml1";
  const mode = statSync(path).mode;
  const temporaryDirectory = mkdtempSync(
    join(dirname(path), `.${basename(path)}.patch-`)
  );
  const replacement = join(temporaryDirectory, basename(path));

  try {
    serializePlist(value, replacement, format);
    chmodSync(replacement, mode);
    renameSync(replacement, path);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function readAppInfo(appPath) {
  return readPlist(join(appPath, "Contents", "Info.plist"));
}

export function appVersion(appPath) {
  const version = readAppInfo(appPath).CFBundleShortVersionString;
  return typeof version === "string" && version.length > 0 ? version : null;
}

export function updateAppIntegrity(appPath, headerHash, sourceHeaderHash) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  const plist = readPlist(plistPath);
  const appASAR = plist?.ElectronAsarIntegrity?.["Resources/app.asar"];

  invariant(
    appASAR?.algorithm === "SHA256" && typeof appASAR.hash === "string",
    "INVALID_PLIST",
    "Claude's Info.plist does not contain the expected Electron ASAR integrity settings."
  );

  appASAR.hash = headerHash;
  plist[SOURCE_ASAR_HASH_KEY] = sourceHeaderHash;
  writePlistAtomically(plistPath, plist);
}

export function readAppIntegrity(appPath) {
  const plist = readAppInfo(appPath);
  const appASAR = plist?.ElectronAsarIntegrity?.["Resources/app.asar"];
  invariant(
    appASAR?.algorithm === "SHA256" && typeof appASAR.hash === "string",
    "INVALID_PLIST",
    "Claude's Info.plist does not contain the expected Electron ASAR integrity settings."
  );
  return {
    headerHash: appASAR.hash,
    sourceHeaderHash:
      typeof plist[SOURCE_ASAR_HASH_KEY] === "string"
        ? plist[SOURCE_ASAR_HASH_KEY]
        : null,
  };
}
