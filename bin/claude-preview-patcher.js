#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline/promises";

import { PatcherError } from "../src/errors.js";
import {
  checkSource,
  openPatchedApp,
  patchClaude,
  standardConfiguration,
} from "../src/patcher.js";
import { checkPrerequisites, formatPrerequisites } from "../src/prerequisites.js";

const VERSION = "0.1.0";

function usage() {
  return `Claude Preview Patcher ${VERSION}

Usage:
  claude-preview-patcher [options]

Options:
  --check                 Verify prerequisites and Claude compatibility only
  --doctor                Verify Node.js and required macOS tools only
  --dry-run               Alias for --check
  --yes, -y               Do not ask for confirmation
  --open                  Open the patched app after installation
  --source <path>         Source app (default: /Applications/Claude.app)
  --destination <path>    Patched app destination
  --help, -h              Show this help
  --version, -v           Show the version

The command never patches the official Claude app in place.`;
}

function parseArguments(argv) {
  const options = {
    command: "patch",
    confirm: true,
    open: false,
    ...standardConfiguration,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--check":
      case "--dry-run":
        options.command = "check";
        break;
      case "--doctor":
        options.command = "doctor";
        break;
      case "--yes":
      case "-y":
        options.confirm = false;
        break;
      case "--open":
        options.open = true;
        break;
      case "--source":
        index += 1;
        if (!argv[index]) {
          throw new PatcherError("USAGE", "--source requires a path.");
        }
        options.sourceApp = argv[index];
        break;
      case "--destination":
        index += 1;
        if (!argv[index]) {
          throw new PatcherError("USAGE", "--destination requires a path.");
        }
        options.destinationApp = argv[index];
        break;
      case "--help":
      case "-h":
        options.command = "help";
        break;
      case "--version":
      case "-v":
        options.command = "version";
        break;
      default:
        throw new PatcherError("USAGE", `Unknown option: ${argument}`);
    }
  }

  return options;
}

async function confirmPatch(options, source) {
  if (!options.confirm) {
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new PatcherError(
      "CONFIRMATION_REQUIRED",
      "Confirmation is required in a non-interactive terminal. Re-run with --yes."
    );
  }

  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await terminal.question(
      `Create ${options.destinationApp} from Claude ${source.version}? [y/N] `
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new PatcherError("CANCELLED", "No changes were made.");
    }
  } finally {
    terminal.close();
  }
}

function printSourceSummary(source) {
  console.log(`[ok] Official Claude ${source.version}`);
  console.log(`[ok] Anthropic signature verified`);
  console.log(`[ok] Supported rule: ${source.recipeName}`);
  console.log(`[ok] ASAR integrity verified`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.command === "help") {
    console.log(usage());
    return;
  }
  if (options.command === "version") {
    console.log(VERSION);
    return;
  }

  console.log(`Claude Preview Patcher ${VERSION}\n`);
  const prerequisites = checkPrerequisites({ needsOpen: options.open });
  console.log(formatPrerequisites(prerequisites));

  if (options.command === "doctor") {
    console.log("\n[ok] This Mac has everything the patcher needs.");
    return;
  }

  console.log("\nChecking the official Claude app...");
  const source = checkSource(options);
  printSourceSummary(source);

  if (options.command === "check") {
    console.log("\n[ok] Compatible. No files were changed.");
    return;
  }

  await confirmPatch(options, source);
  console.log("");

  const result = patchClaude(options, {
    progress(message) {
      console.log(`-> ${message}`);
    },
  });

  console.log(`\n[ok] Created ${result.destinationApp}`);
  console.log(`[ok] Patched copy verified`);
  if (result.cleanupWarning) {
    console.warn(`[warning] ${result.cleanupWarning}`);
  }

  if (options.open) {
    openPatchedApp(result.destinationApp);
    console.log("[ok] Opened patched Claude");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[error] ${message}`);
  if (error?.code === "USAGE") {
    console.error(`\n${usage()}`);
    process.exitCode = 2;
  } else if (error?.code === "CANCELLED") {
    process.exitCode = 0;
  } else {
    process.exitCode = 1;
  }
});
