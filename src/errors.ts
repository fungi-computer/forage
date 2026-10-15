import type { ForageFailure } from "./schemas.js";

/** A bounded, machine-readable failure at a Forage public seam. */
export class ForageError extends Error {
  readonly code: ForageFailure["code"];
  readonly failure: ForageFailure;

  constructor(
    code: ForageFailure["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    const boundedMessage = message.slice(0, 1000);
    super(boundedMessage, options);
    this.name = "ForageError";
    this.code = code;
    this.failure = { code, message: boundedMessage };
  }
}
