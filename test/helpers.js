import { createHash } from "node:crypto";

function uint32(value) {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return data;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function alignedToFour(value) {
  return (value + 3) & ~3;
}

export function makeASAR(fileData) {
  const fileHash = sha256(fileData);
  const headerJSON = Buffer.from(
    JSON.stringify({
      files: {
        ".vite": {
          files: {
            build: {
              files: {
                "index.js": {
                  size: fileData.length,
                  offset: "0",
                  integrity: {
                    algorithm: "SHA256",
                    hash: fileHash,
                    blockSize: 4 * 1024 * 1024,
                    blocks: [fileHash],
                  },
                },
              },
            },
          },
        },
      },
    }),
    "utf8"
  );
  const paddedLength = alignedToFour(headerJSON.length);
  const payloadSize = 4 + paddedLength;
  const headerPickle = Buffer.concat([
    uint32(payloadSize),
    uint32(headerJSON.length),
    headerJSON,
    Buffer.alloc(paddedLength - headerJSON.length),
  ]);
  return Buffer.concat([uint32(4), uint32(headerPickle.length), headerPickle, fileData]);
}
