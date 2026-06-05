import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  patchArchive,
  sha256,
  verifyInternalIntegrity,
  verifyPatchedArchive,
} from "./asar.js";
import { runCommand } from "./command.js";
import { PatcherError, invariant } from "./errors.js";
import {
  appVersion,
  readAppIntegrity,
  updateAppIntegrity,
} from "./plist.js";
import { checkPrerequisites, tools } from "./prerequisites.js";
import { locatePatch, verifyPatchedRecipe } from "./recipes.js";
import {
  signAdHoc,
  validateOfficialClaude,
  verifyCodeSignature,
  verifyMainEntitlements,
} from "./signing.js";

export const standardConfiguration = Object.freeze({
  sourceApp: "/Applications/Claude.app",
  destinationApp: "/Applications/Claude (Patched).app",
});

function normalizedConfiguration(configuration = {}) {
  return {
    sourceApp: resolve(
      configuration.sourceApp ?? standardConfiguration.sourceApp
    ),
    destinationApp: resolve(
      configuration.destinationApp ?? standardConfiguration.destinationApp
    ),
  };
}

function asarPath(appPath) {
  return join(appPath, "Contents", "Resources", "app.asar");
}

function assertAppDirectory(path, label) {
  invariant(
    existsSync(path) && statSync(path).isDirectory(),
    "MISSING_APP",
    `${label} was not found at ${path}.`
  );
}

export function isAppRunning(appPath) {
  const output = runCommand(tools.ps, ["-axo", "pid=,command="]).stdout;
  return output
    .split("\n")
    .some((line) => line.includes(`${resolve(appPath)}/Contents/`));
}

function assertAppsAreStopped(sourceApp, destinationApp) {
  invariant(
    !isAppRunning(sourceApp),
    "APP_RUNNING",
    `Quit the official Claude app before patching: ${sourceApp}`
  );
  invariant(
    !isAppRunning(destinationApp),
    "APP_RUNNING",
    `Quit the patched Claude app before replacing it: ${destinationApp}`
  );
}

export function checkSource(configuration = {}) {
  checkPrerequisites();
  const { sourceApp, destinationApp } = normalizedConfiguration(configuration);
  invariant(
    sourceApp !== destinationApp,
    "INVALID_DESTINATION",
    "The destination must be different from the official Claude app."
  );
  assertAppDirectory(sourceApp, "The official Claude app");
  validateOfficialClaude(sourceApp);

  const archivePath = asarPath(sourceApp);
  const inspection = verifyInternalIntegrity(archivePath);
  const application = locatePatch(inspection.fileData);
  const version = appVersion(sourceApp);
  invariant(
    version,
    "INVALID_PLIST",
    "Claude's version could not be read from Info.plist."
  );

  return {
    sourceApp,
    destinationApp,
    version,
    recipeName: application.recipeName,
    archiveSize: inspection.archiveSize,
    headerHash: sha256(inspection.headerJSON),
    fileHash: sha256(inspection.fileData),
  };
}

function compareStagedSource(stagedApp, source) {
  validateOfficialClaude(stagedApp);
  const inspection = verifyInternalIntegrity(asarPath(stagedApp));
  invariant(
    inspection.archiveSize === source.archiveSize &&
      sha256(inspection.headerJSON) === source.headerHash &&
      sha256(inspection.fileData) === source.fileHash &&
      appVersion(stagedApp) === source.version,
    "SOURCE_CHANGED",
    "The staged Claude copy does not match the source that passed preflight. Nothing was installed."
  );
}

export function verifyPatchedApp(
  appPath,
  {
    sourceHeaderHash,
    expectedVersion,
    patchResult,
    expectedMainEntitlements,
  }
) {
  assertAppDirectory(appPath, "The patched Claude app");
  const inspection = patchResult
    ? verifyPatchedArchive(asarPath(appPath), patchResult)
    : verifyInternalIntegrity(asarPath(appPath));
  verifyPatchedRecipe(inspection.fileData);

  const plistIntegrity = readAppIntegrity(appPath);
  invariant(
    plistIntegrity.headerHash === sha256(inspection.headerJSON),
    "VERIFICATION_FAILED",
    "Info.plist contains the wrong ASAR header hash."
  );
  invariant(
    plistIntegrity.sourceHeaderHash === sourceHeaderHash,
    "VERIFICATION_FAILED",
    "The patched copy does not record the expected source ASAR fingerprint."
  );
  invariant(
    appVersion(appPath) === expectedVersion,
    "VERIFICATION_FAILED",
    "The patched copy's Claude version changed."
  );
  verifyCodeSignature(appPath);
  if (expectedMainEntitlements !== undefined) {
    verifyMainEntitlements(appPath, expectedMainEntitlements);
  }
}

export function installStagedApp({
  stagingApp,
  destinationApp,
  backupApp,
  verifyInstalled,
}) {
  const destinationExisted = existsSync(destinationApp);
  if (destinationExisted) {
    try {
      renameSync(destinationApp, backupApp);
    } catch (error) {
      throw new PatcherError(
        "INSTALL_FAILED",
        `The existing patched app could not be moved to a backup: ${error.message}`,
        { cause: error }
      );
    }
  }

  try {
    renameSync(stagingApp, destinationApp);
    verifyInstalled(destinationApp);
  } catch (error) {
    try {
      rmSync(destinationApp, { recursive: true, force: true });
      if (destinationExisted && existsSync(backupApp)) {
        renameSync(backupApp, destinationApp);
      }
    } catch (rollbackError) {
      throw new PatcherError(
        "INSTALL_ROLLBACK_FAILED",
        `Installation failed and automatic rollback also failed. The previous patched app remains at ${backupApp}.`,
        { cause: rollbackError }
      );
    }
    throw new PatcherError(
      "INSTALL_FAILED",
      `The patched app could not be installed: ${error.message}`,
      { cause: error }
    );
  }

  let cleanupWarning = null;
  if (destinationExisted) {
    try {
      rmSync(backupApp, { recursive: true, force: true });
    } catch (error) {
      cleanupWarning =
        `The new app is installed, but the previous hidden backup could not be removed: ${backupApp}`;
    }
  }
  return { cleanupWarning };
}

export function patchClaude(configuration = {}, hooks = {}) {
  const progress = hooks.progress ?? (() => {});
  checkPrerequisites();
  const { sourceApp, destinationApp } = normalizedConfiguration(configuration);
  assertAppsAreStopped(sourceApp, destinationApp);

  progress("Checking the official Claude app");
  const source = checkSource({ sourceApp, destinationApp });

  const parent = dirname(destinationApp);
  mkdirSync(parent, { recursive: true });
  try {
    accessSync(parent, constants.W_OK);
  } catch (error) {
    throw new PatcherError(
      "DESTINATION_NOT_WRITABLE",
      `The destination folder is not writable: ${parent}. Do not run npx with sudo; choose a writable --destination instead.`,
      { cause: error }
    );
  }

  const token = randomUUID();
  const destinationName = basename(destinationApp);
  const stagingApp = join(parent, `.${destinationName}.${token}.partial`);
  const backupApp = join(parent, `.${destinationName}.${token}.backup`);

  rmSync(stagingApp, { recursive: true, force: true });
  rmSync(backupApp, { recursive: true, force: true });

  try {
    progress("Copying Claude to a temporary location");
    runCommand(tools.ditto, [sourceApp, stagingApp]);

    progress("Verifying the temporary copy");
    compareStagedSource(stagingApp, source);

    progress("Applying the fixed-length HTTPS patch");
    const patchResult = patchArchive(asarPath(stagingApp));

    progress("Updating Electron integrity information");
    updateAppIntegrity(stagingApp, patchResult.headerHash, source.headerHash);

    progress("Re-signing the patched copy with sanitized entitlements");
    const signing = signAdHoc(stagingApp);

    progress("Verifying the patched copy");
    const verification = {
      sourceHeaderHash: source.headerHash,
      expectedVersion: source.version,
      patchResult,
      expectedMainEntitlements: signing.mainEntitlements,
    };
    verifyPatchedApp(stagingApp, verification);

    progress("Installing the verified patched copy");
    assertAppsAreStopped(sourceApp, destinationApp);
    const installation = installStagedApp({
      stagingApp,
      destinationApp,
      backupApp,
      verifyInstalled(appPath) {
        verifyPatchedApp(appPath, verification);
      },
    });

    return {
      sourceApp,
      destinationApp,
      version: source.version,
      recipeName: patchResult.recipeName,
      cleanupWarning: installation.cleanupWarning,
    };
  } finally {
    rmSync(stagingApp, { recursive: true, force: true });
  }
}

export function openPatchedApp(appPath) {
  assertAppDirectory(appPath, "The patched Claude app");
  runCommand(tools.open, ["-n", appPath]);
}
