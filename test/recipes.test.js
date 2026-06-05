import assert from "node:assert/strict";
import test from "node:test";

import {
  findPatchedApplications,
  locatePatch,
  verifyPatchedRecipe,
} from "../src/recipes.js";

const prefix = "class Preview{isAllowedUrl(A){const t=new URL(A);";
const suffix =
  '}notifyBlockedNavigation(A){show("Preview only supports localhost URLs.")}}';

test("current rule creates an equal-length patch", () => {
  const source = Buffer.from(
    `${prefix}return R9(t.hostname)&&(t.protocol==="http:"||t.protocol==="https:")${suffix}`
  );
  const application = locatePatch(source);
  assert.equal(application.original.length, application.replacement.length);

  const patched = Buffer.from(source);
  application.replacement.copy(patched, application.start);
  verifyPatchedRecipe(patched);
});

test("legacy rule creates an equal-length padded patch", () => {
  const source = Buffer.from(
    `${prefix}return R9(t.hostname)&&t.port===\`\${this.port}\`${suffix}`
  );
  const application = locatePatch(source);
  assert.equal(application.original.length, application.replacement.length);

  const patched = Buffer.from(source);
  application.replacement.copy(patched, application.start);
  assert.equal(findPatchedApplications(patched).length, 1);
});

test("unknown rules fail closed", () => {
  const source = Buffer.from(
    `${prefix}return allowAnything(t)${suffix}`
  );
  assert.throws(() => locatePatch(source), {
    code: "UNSUPPORTED_CLAUDE_VERSION",
  });
});

test("multiple matching rules are rejected", () => {
  const gate =
    'return R9(t.hostname)&&(t.protocol==="http:"||t.protocol==="https:")';
  const source = Buffer.from(
    `${prefix}${gate}${suffix}${prefix}${gate}${suffix}`
  );
  assert.throws(() => locatePatch(source), {
    code: "AMBIGUOUS_PATCH_SITE",
  });
});
