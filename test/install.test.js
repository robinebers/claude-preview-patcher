import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installStagedApp } from "../src/patcher.js";

test("failed post-install verification restores the previous destination", () => {
  const directory = mkdtempSync(join(tmpdir(), "patcher-install-test-"));
  const destinationApp = join(directory, "Claude (Patched).app");
  const stagingApp = join(directory, "staging.app");
  const backupApp = join(directory, "backup.app");
  try {
    mkdirSync(destinationApp);
    mkdirSync(stagingApp);
    writeFileSync(join(destinationApp, "marker.txt"), "previous copy");

    assert.throws(
      () =>
        installStagedApp({
          stagingApp,
          destinationApp,
          backupApp,
          verifyInstalled() {
            throw new Error("deliberate verification failure");
          },
        }),
      { code: "INSTALL_FAILED" }
    );

    assert.equal(
      readFileSync(join(destinationApp, "marker.txt"), "utf8"),
      "previous copy"
    );
    assert.equal(existsSync(backupApp), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
