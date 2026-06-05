import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";

import { runCommand } from "./command.js";
import { PatcherError, invariant } from "./errors.js";
import { readPlist, serializePlist } from "./plist.js";
import { tools } from "./prerequisites.js";

const forbiddenEntitlements = [
  "com.apple.application-identifier",
  "com.apple.developer.team-identifier",
  "keychain-access-groups",
];

export function validateOfficialClaude(appPath) {
  runCommand(tools.codesign, ["--verify", "--deep", "--strict", appPath]);
  const details = runCommand(tools.codesign, ["-dvv", appPath]).combinedOutput;
  invariant(
    details.includes("Identifier=com.anthropic.claudefordesktop") &&
      details.includes("TeamIdentifier=Q6L2SF6YDW") &&
      details.includes("Anthropic PBC"),
    "SOURCE_SIGNATURE_INVALID",
    "The source app is not signed by the expected Anthropic team."
  );
}

function walkDirectories(root, visitor) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      visitor(path);
      walkDirectories(path, visitor);
    }
  }
}

function nestedCodeBundles(appPath) {
  const extensions = [".app", ".framework", ".xpc", ".appex"];
  const bundles = [];
  walkDirectories(join(appPath, "Contents"), (path) => {
    if (extensions.some((extension) => path.endsWith(extension))) {
      bundles.push(path);
    }
  });
  return bundles.sort((left, right) => {
    const depthDifference =
      relative(appPath, right).split("/").length -
      relative(appPath, left).split("/").length;
    return depthDifference || left.localeCompare(right);
  });
}

function executableHelpers(appPath) {
  const helpers = [];
  const root = join(appPath, "Contents", "Helpers");

  function collect(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        collect(path);
      } else if (entry.isFile()) {
        try {
          accessSync(path, constants.X_OK);
          helpers.push(path);
        } catch {
          // A non-executable helper is a resource, not a code-signing target.
        }
      }
    }
  }

  collect(root);
  return helpers.sort();
}

export function readEntitlements(targetPath) {
  const output = runCommand(tools.codesign, [
    "-d",
    "--entitlements",
    "-",
    "--xml",
    targetPath,
  ]).combinedOutput;
  const start = output.indexOf("<plist");
  const end = output.indexOf("</plist>");
  if (start === -1 || end === -1) {
    return null;
  }

  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "claude-preview-entitlements-read-")
  );
  const plistPath = join(temporaryDirectory, "entitlements.plist");
  try {
    writeFileSync(
      plistPath,
      `${output.slice(start, end + "</plist>".length)}\n`,
      { mode: 0o600 }
    );
    return readPlist(plistPath);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function sanitizeEntitlements(entitlements) {
  if (!entitlements) {
    return null;
  }
  const sanitized = structuredClone(entitlements);
  for (const key of forbiddenEntitlements) {
    delete sanitized[key];
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function signTarget(targetPath, entitlementsPath) {
  const argumentsList = [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--options",
    "runtime",
    "--generate-entitlement-der",
  ];
  if (entitlementsPath) {
    argumentsList.push("--entitlements", entitlementsPath);
  }
  argumentsList.push(targetPath);
  runCommand(tools.codesign, argumentsList);
}

function writeEntitlements(entitlements, directory, index) {
  if (!entitlements) {
    return null;
  }
  const path = join(directory, `entitlements-${index}.plist`);
  serializePlist(entitlements, path, "xml1");
  return path;
}

export function verifyCodeSignature(appPath) {
  runCommand(tools.codesign, ["--verify", "--deep", "--strict", appPath]);
}

function verifyExpectedEntitlements(expectations) {
  for (const { targetPath, entitlements } of expectations) {
    const actual = readEntitlements(targetPath);
    invariant(
      isDeepStrictEqual(actual, entitlements),
      "ENTITLEMENTS_MISMATCH",
      `The re-signed entitlements do not match for ${targetPath}.`
    );
    for (const key of forbiddenEntitlements) {
      invariant(
        !actual || !(key in actual),
        "ENTITLEMENTS_MISMATCH",
        `The team-bound entitlement ${key} remained on ${targetPath}.`
      );
    }
  }
}

export function signAdHoc(appPath) {
  runCommand(tools.xattr, ["-cr", appPath]);
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "claude-preview-patcher-entitlements-")
  );
  const expectations = [];

  try {
    const targets = [
      ...nestedCodeBundles(appPath),
      ...executableHelpers(appPath),
      join(appPath, "Contents", "MacOS", "Claude"),
    ];

    for (const [index, targetPath] of targets.entries()) {
      invariant(
        lstatSync(targetPath).isFile() || lstatSync(targetPath).isDirectory(),
        "SIGNING_FAILED",
        `The signing target does not exist: ${targetPath}`
      );
      const entitlements = sanitizeEntitlements(readEntitlements(targetPath));
      const entitlementsPath = writeEntitlements(
        entitlements,
        temporaryDirectory,
        index
      );
      signTarget(targetPath, entitlementsPath);
      expectations.push({ targetPath, entitlements });
    }

    const mainEntitlements =
      expectations.at(-1)?.entitlements ??
      sanitizeEntitlements(
        readEntitlements(join(appPath, "Contents", "MacOS", "Claude"))
      );
    const rootEntitlementsPath = writeEntitlements(
      mainEntitlements,
      temporaryDirectory,
      targets.length
    );
    signTarget(appPath, rootEntitlementsPath);
    expectations.push({ targetPath: resolve(appPath), entitlements: mainEntitlements });

    verifyCodeSignature(appPath);
    verifyExpectedEntitlements(expectations);
    return { mainEntitlements };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function verifyMainEntitlements(appPath, expected) {
  const mainExecutable = join(appPath, "Contents", "MacOS", "Claude");
  const actual = readEntitlements(mainExecutable);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new PatcherError(
      "ENTITLEMENTS_MISMATCH",
      "Claude's main executable did not retain the verified sanitized entitlements."
    );
  }
}
