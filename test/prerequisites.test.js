import assert from "node:assert/strict";
import test from "node:test";

import { checkPrerequisites } from "../src/prerequisites.js";

test("current Mac satisfies the runtime prerequisites", () => {
  const result = checkPrerequisites();
  assert.ok(Number.parseInt(result.nodeVersion.split(".")[0], 10) >= 20);
  assert.ok(result.tools.length >= 5);
});
