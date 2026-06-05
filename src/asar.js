import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";

import { PatcherError, invariant } from "./errors.js";
import { locatePatch, verifyPatchedRecipe } from "./recipes.js";

export const PREVIEW_BUNDLE_PATH = ".vite/build/index.js";

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function alignToFour(value) {
  return (value + 3) & ~3;
}

function readExactly(fileDescriptor, length, position) {
  const result = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const count = readSync(
      fileDescriptor,
      result,
      total,
      length - total,
      position + total
    );
    if (count === 0) {
      throw new PatcherError(
        "MALFORMED_ARCHIVE",
        "Claude's application archive ended unexpectedly."
      );
    }
    total += count;
  }
  return result;
}

function writeAll(fileDescriptor, data, position) {
  let total = 0;
  while (total < data.length) {
    const count = writeSync(
      fileDescriptor,
      data,
      total,
      data.length - total,
      position + total
    );
    if (count === 0) {
      throw new PatcherError(
        "WRITE_FAILED",
        "A complete ASAR write could not be performed."
      );
    }
    total += count;
  }
}

function archiveNode(root, path) {
  let current = root;
  for (const component of path.split("/")) {
    current = current?.files?.[component];
    if (!current) {
      throw new PatcherError(
        "MISSING_ARCHIVE_ENTRY",
        `Claude's application archive does not contain ${path}.`
      );
    }
  }
  return current;
}

function validateHash(value, label) {
  invariant(
    typeof value === "string" && /^[a-f0-9]{64}$/i.test(value),
    "MALFORMED_ARCHIVE",
    `${label} is not a SHA-256 hash.`
  );
}

export function inspectArchive(archivePath, entryPath = PREVIEW_BUNDLE_PATH) {
  const fileDescriptor = openSync(archivePath, "r");
  try {
    const archiveSize = fstatSync(fileDescriptor).size;
    const outerHeader = readExactly(fileDescriptor, 8, 0);
    invariant(
      outerHeader.readUInt32LE(0) === 4,
      "MALFORMED_ARCHIVE",
      "The outer ASAR pickle payload is not four bytes."
    );

    const headerSize = outerHeader.readUInt32LE(4);
    invariant(
      headerSize >= 8 && 8 + headerSize <= archiveSize,
      "MALFORMED_ARCHIVE",
      "The ASAR header size is invalid."
    );

    const headerPickle = readExactly(fileDescriptor, headerSize, 8);
    const payloadSize = headerPickle.readUInt32LE(0);
    const stringLength = headerPickle.readUInt32LE(4);
    invariant(
      headerSize === payloadSize + 4 &&
        payloadSize === 4 + alignToFour(stringLength) &&
        8 + stringLength <= headerPickle.length,
      "MALFORMED_ARCHIVE",
      "The ASAR header lengths are inconsistent."
    );

    const headerJSON = Buffer.from(headerPickle.subarray(8, 8 + stringLength));
    let root;
    try {
      root = JSON.parse(headerJSON.toString("utf8"));
    } catch (error) {
      throw new PatcherError(
        "MALFORMED_ARCHIVE",
        "The ASAR header is not valid JSON.",
        { cause: error }
      );
    }

    const node = archiveNode(root, entryPath);
    invariant(
      node.unpacked !== true,
      "UNPACKED_ARCHIVE_ENTRY",
      `${entryPath} is unexpectedly stored outside Claude's application archive.`
    );
    invariant(
      Number.isSafeInteger(node.size) &&
        node.size >= 0 &&
        typeof node.offset === "string" &&
        /^[0-9]+$/.test(node.offset) &&
        node.integrity &&
        typeof node.integrity === "object",
      "MALFORMED_ARCHIVE",
      `${entryPath} has incomplete file metadata.`
    );

    const relativeOffset = Number(node.offset);
    const integrity = node.integrity;
    invariant(
      Number.isSafeInteger(relativeOffset) &&
        relativeOffset >= 0 &&
        integrity.algorithm === "SHA256" &&
        Number.isSafeInteger(integrity.blockSize) &&
        integrity.blockSize > 0 &&
        Array.isArray(integrity.blocks),
      "MALFORMED_ARCHIVE",
      `${entryPath} has unsupported integrity metadata.`
    );
    validateHash(integrity.hash, `${entryPath}'s integrity hash`);
    integrity.blocks.forEach((hash, index) =>
      validateHash(hash, `${entryPath}'s block ${index} hash`)
    );

    const expectedBlocks = Math.max(1, Math.ceil(node.size / integrity.blockSize));
    invariant(
      integrity.blocks.length === expectedBlocks,
      "MALFORMED_ARCHIVE",
      `${entryPath} has an inconsistent integrity block count.`
    );

    const dataStart = 8 + headerSize;
    const fileOffset = dataStart + relativeOffset;
    invariant(
      Number.isSafeInteger(fileOffset) &&
        fileOffset <= archiveSize &&
        node.size <= archiveSize - fileOffset,
      "MALFORMED_ARCHIVE",
      `${entryPath} extends past the end of the archive.`
    );

    const fileData = readExactly(fileDescriptor, node.size, fileOffset);
    return {
      archiveSize,
      headerSize,
      headerJSON,
      fileData,
      fileOffset,
      fileIntegrity: {
        algorithm: integrity.algorithm,
        hash: integrity.hash,
        blockSize: integrity.blockSize,
        blocks: [...integrity.blocks],
      },
    };
  } finally {
    closeSync(fileDescriptor);
  }
}

export function makeIntegrity(data, blockSize) {
  const blocks = [];
  if (data.length === 0) {
    blocks.push(sha256(Buffer.alloc(0)));
  } else {
    for (let offset = 0; offset < data.length; offset += blockSize) {
      blocks.push(sha256(data.subarray(offset, Math.min(offset + blockSize, data.length))));
    }
  }
  return {
    algorithm: "SHA256",
    hash: sha256(data),
    blockSize,
    blocks,
  };
}

function bufferRanges(buffer, needle) {
  const ranges = [];
  let start = 0;
  while (start <= buffer.length - needle.length) {
    const index = buffer.indexOf(needle, start);
    if (index === -1) {
      break;
    }
    ranges.push({ start: index, end: index + needle.length });
    start = index + needle.length;
  }
  return ranges;
}

function replaceIntegrityHashes(header, original, patched) {
  invariant(
    original.blockSize === patched.blockSize &&
      original.blocks.length === patched.blocks.length,
    "INTEGRITY_METADATA_MISMATCH",
    "Claude's integrity block layout changed."
  );

  const replacements = new Map();
  const oldValues = [original.hash, ...original.blocks];
  const newValues = [patched.hash, ...patched.blocks];
  for (let index = 0; index < oldValues.length; index += 1) {
    const oldValue = oldValues[index];
    const newValue = newValues[index];
    if (oldValue === newValue) {
      continue;
    }
    const existing = replacements.get(oldValue);
    invariant(
      !existing || existing.newValue === newValue,
      "INTEGRITY_METADATA_MISMATCH",
      "One original integrity hash would require two different replacements."
    );
    replacements.set(oldValue, {
      newValue,
      expectedCount: (existing?.expectedCount ?? 0) + 1,
    });
  }

  for (const [oldValue, replacement] of replacements) {
    const oldData = Buffer.from(oldValue, "ascii");
    const newData = Buffer.from(replacement.newValue, "ascii");
    const ranges = bufferRanges(header, oldData);
    invariant(
      ranges.length === replacement.expectedCount,
      "INTEGRITY_METADATA_MISMATCH",
      `Integrity hash ${oldValue.slice(0, 12)} appeared ${ranges.length} times; expected ${replacement.expectedCount}.`
    );
    for (const range of ranges) {
      newData.copy(header, range.start);
    }
  }
}

export function patchArchive(archivePath) {
  const inspection = inspectArchive(archivePath);
  const application = locatePatch(inspection.fileData);
  invariant(
    inspection.fileData
      .subarray(application.start, application.end)
      .equals(application.original),
    "VERIFICATION_FAILED",
    "The located patch bytes changed before writing."
  );

  const patchedFile = Buffer.from(inspection.fileData);
  application.replacement.copy(patchedFile, application.start);
  invariant(
    patchedFile.length === inspection.fileData.length,
    "REPLACEMENT_LENGTH_MISMATCH",
    "The fixed-length patch changed the target file size."
  );

  const patchedIntegrity = makeIntegrity(
    patchedFile,
    inspection.fileIntegrity.blockSize
  );
  const patchedHeader = Buffer.from(inspection.headerJSON);
  replaceIntegrityHashes(
    patchedHeader,
    inspection.fileIntegrity,
    patchedIntegrity
  );
  invariant(
    patchedHeader.length === inspection.headerJSON.length,
    "INTEGRITY_METADATA_MISMATCH",
    "The ASAR header length changed."
  );

  const fileDescriptor = openSync(archivePath, "r+");
  try {
    writeAll(fileDescriptor, patchedFile, inspection.fileOffset);
    writeAll(fileDescriptor, patchedHeader, 16);
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }

  invariant(
    statSync(archivePath).size === inspection.archiveSize,
    "VERIFICATION_FAILED",
    "The ASAR file size changed."
  );

  return {
    recipeName: application.recipeName,
    archiveSize: inspection.archiveSize,
    headerHash: sha256(patchedHeader),
    fileHash: patchedIntegrity.hash,
  };
}

export function verifyInternalIntegrity(archivePath) {
  const inspection = inspectArchive(archivePath);
  const actual = makeIntegrity(
    inspection.fileData,
    inspection.fileIntegrity.blockSize
  );
  invariant(
    JSON.stringify(actual) === JSON.stringify(inspection.fileIntegrity),
    "VERIFICATION_FAILED",
    "index.js integrity metadata does not match its bytes."
  );
  return inspection;
}

export function verifyPatchedArchive(
  archivePath,
  { archiveSize, headerHash, fileHash }
) {
  const inspection = inspectArchive(archivePath);
  invariant(
    inspection.archiveSize === archiveSize,
    "VERIFICATION_FAILED",
    "The patched ASAR size no longer matches the staged copy."
  );
  invariant(
    sha256(inspection.headerJSON) === headerHash,
    "VERIFICATION_FAILED",
    "The patched ASAR header hash does not match."
  );
  const actual = makeIntegrity(
    inspection.fileData,
    inspection.fileIntegrity.blockSize
  );
  invariant(
    JSON.stringify(actual) === JSON.stringify(inspection.fileIntegrity) &&
      actual.hash === fileHash,
    "VERIFICATION_FAILED",
    "The patched index.js integrity metadata does not match its bytes."
  );
  verifyPatchedRecipe(inspection.fileData);
  return inspection;
}
