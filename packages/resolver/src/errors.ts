export type ResolverErrorCode =
  /** The package is not cached and the mode forbids reaching the network. */
  | "PACKAGE_NOT_CACHED"
  /** The registry does not have it, or returned a non-200. */
  | "PACKAGE_NOT_FOUND"
  /** Content did not match the lockfile. Nothing is installed on this path. */
  | "INTEGRITY_MISMATCH"
  /** The archive downloaded but could not be read as a package. */
  | "INVALID_PACKAGE"
  | "NETWORK_ERROR"
  | "INVALID_SPEC";

/** Every failure this package produces, with a code worth branching on. */
export class ResolverError extends Error {
  override readonly name = "ResolverError";
  readonly code: ResolverErrorCode;
  /** The package this is about, when there is one. */
  readonly spec: string | undefined;

  constructor(
    code: ResolverErrorCode,
    message: string,
    options?: { spec?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.spec = options?.spec;
    Error.captureStackTrace?.(this, ResolverError);
  }
}
