import { TextDecoder } from "node:util";

import { PatcherError } from "./errors.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const identifier = "[A-Za-z_$][A-Za-z0-9_$]*";

function decodeSource(data) {
  try {
    return decoder.decode(data);
  } catch (error) {
    throw new PatcherError(
      "MALFORMED_ARCHIVE",
      ".vite/build/index.js is not valid UTF-8.",
      { cause: error }
    );
  }
}

function hasExpectedContext(source, start, end) {
  const before = source.slice(Math.max(0, start - 800), start);
  const after = source.slice(end, Math.min(source.length, end + 800));
  return (
    before.includes("isAllowedUrl(") &&
    after.includes("Preview only supports localhost URLs.")
  );
}

const recipes = [
  {
    name: "HTTPS or loopback protocol gate",
    expression: new RegExp(
      `return (${identifier})\\((${identifier})\\.hostname\\)&&\\(\\2\\.protocol==="http:"\\|\\|\\2\\.protocol==="https:"\\)`,
      "g"
    ),
    replacement(match) {
      const loopbackFunction = match[1];
      const urlVariable = match[2];
      return `return ${urlVariable}.protocol==="https:"||${loopbackFunction}(${urlVariable}.hostname)&&(${urlVariable}.protocol==="http:")`;
    },
  },
  {
    name: "Legacy localhost and port gate",
    expression: new RegExp(
      `return (${identifier})\\((${identifier})\\.hostname\\)&&\\2\\.port===\`\\$\\{this\\.port\\}\``,
      "g"
    ),
    replacement(match) {
      const loopbackFunction = match[1];
      const urlVariable = match[2];
      const replacement =
        `return ${urlVariable}.protocol==="https:"||${loopbackFunction}(${urlVariable}.hostname)`;
      const padding = Buffer.byteLength(match[0]) - Buffer.byteLength(replacement);
      if (padding < 0) {
        throw new PatcherError(
          "REPLACEMENT_LENGTH_MISMATCH",
          "The safe fixed-length legacy patch could not be created."
        );
      }
      return replacement + " ".repeat(padding);
    },
  },
];

const patchedExpressions = [
  new RegExp(
    `return (${identifier})\\.protocol==="https:"\\|\\|(${identifier})\\(\\1\\.hostname\\)&&\\(\\1\\.protocol==="http:"\\)`,
    "g"
  ),
  new RegExp(
    `return (${identifier})\\.protocol==="https:"\\|\\|(${identifier})\\(\\1\\.hostname\\) +`,
    "g"
  ),
];

function applicationsForRecipe(source, recipe) {
  const expression = new RegExp(recipe.expression.source, recipe.expression.flags);
  const applications = [];
  for (const match of source.matchAll(expression)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!hasExpectedContext(source, start, end)) {
      continue;
    }

    const replacement = recipe.replacement(match);
    const originalData = Buffer.from(match[0], "utf8");
    const replacementData = Buffer.from(replacement, "utf8");
    if (originalData.length !== replacementData.length) {
      throw new PatcherError(
        "REPLACEMENT_LENGTH_MISMATCH",
        "The safe fixed-length patch could not be created."
      );
    }

    const byteStart = Buffer.byteLength(source.slice(0, start), "utf8");
    applications.push({
      recipeName: recipe.name,
      start: byteStart,
      end: byteStart + originalData.length,
      original: originalData,
      replacement: replacementData,
    });
  }
  return applications;
}

export function findPatchApplications(data) {
  const source = decodeSource(data);
  return recipes.flatMap((recipe) => applicationsForRecipe(source, recipe));
}

export function findPatchedApplications(data) {
  const source = decodeSource(data);
  const applications = [];
  for (const original of patchedExpressions) {
    const expression = new RegExp(original.source, original.flags);
    for (const match of source.matchAll(expression)) {
      const start = match.index;
      const end = start + match[0].length;
      if (hasExpectedContext(source, start, end)) {
        applications.push({ start, end, text: match[0] });
      }
    }
  }
  return applications;
}

export function locatePatch(data) {
  const applications = findPatchApplications(data);
  if (applications.length === 1) {
    return applications[0];
  }
  if (applications.length > 1) {
    throw new PatcherError(
      "AMBIGUOUS_PATCH_SITE",
      `Claude contains ${applications.length} possible Preview restrictions instead of exactly one. Nothing was changed.`
    );
  }

  if (findPatchedApplications(data).length > 0) {
    throw new PatcherError(
      "ALREADY_PATCHED",
      "The source Claude app already appears to contain this patch."
    );
  }
  throw new PatcherError(
    "UNSUPPORTED_CLAUDE_VERSION",
    "This Claude version uses a Preview restriction the patcher does not recognize. Nothing was changed."
  );
}

export function verifyPatchedRecipe(data) {
  const original = findPatchApplications(data);
  const patched = findPatchedApplications(data);
  if (original.length !== 0 || patched.length !== 1) {
    throw new PatcherError(
      "VERIFICATION_FAILED",
      "The HTTPS patch was not uniquely identifiable after writing."
    );
  }
}
