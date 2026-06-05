import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkSource, patchClaude, verifyPatchedApp } from "../src/patcher.js";

const enabled = process.env.RUN_FULL_CLAUDE_PATCH_TEST === "1";

test(
  "full pipeline patches and verifies a disposable real Claude copy",
  { skip: enabled ? false : "Set RUN_FULL_CLAUDE_PATCH_TEST=1 to enable" },
  () => {
    const destinationApp = join(
      tmpdir(),
      `Claude Preview Patcher Integration ${process.pid}.app`
    );
    rmSync(destinationApp, { recursive: true, force: true });
    try {
      const source = checkSource({ destinationApp });
      const result = patchClaude({ destinationApp });
      assert.equal(result.destinationApp, destinationApp);

      verifyPatchedApp(destinationApp, {
        sourceHeaderHash: source.headerHash,
        expectedVersion: source.version,
      });
    } finally {
      rmSync(destinationApp, { recursive: true, force: true });
    }
  }
);
