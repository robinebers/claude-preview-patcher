export class PatcherError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "PatcherError";
    this.code = code;
  }
}

export function invariant(condition, code, message) {
  if (!condition) {
    throw new PatcherError(code, message);
  }
}
