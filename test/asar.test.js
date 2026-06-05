import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectArchive,
  patchArchive,
  verifyPatchedArchive,
} from "../src/asar.js";
import { locatePatch } from "../src/recipes.js";
import { makeASAR } from "./helpers.js";

test("patch preserves ASAR size and repairs integrity", () => {
  const directory = mkdtempSync(join(tmpdir(), "asar-patcher-test-"));
  const archivePath = join(directory, "app.asar");
  try {
    const source = Buffer.from(
      'class Preview{isAllowedUrl(A){const t=new URL(A);return R9(t.hostname)&&(t.protocol==="http:"||t.protocol==="https:")}notifyBlockedNavigation(A){show("Preview only supports localhost URLs.")}}'
    );
    const originalArchive = makeASAR(source);
    writeFileSync(archivePath, originalArchive);

    const result = patchArchive(archivePath);
    const patchedArchive = readFileSync(archivePath);
    assert.equal(patchedArchive.length, originalArchive.length);
    assert.notDeepEqual(patchedArchive, originalArchive);
    verifyPatchedArchive(archivePath, result);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installed Claude matches exactly one known recipe", (context) => {
  const archivePath = "/Applications/Claude.app/Contents/Resources/app.asar";
  if (!existsSync(archivePath)) {
    context.skip("Claude.app is not installed");
    return;
  }
  const inspection = inspectArchive(archivePath);
  const application = locatePatch(inspection.fileData);
  assert.equal(application.original.length, application.replacement.length);
});
