/**
 * One file from a resolved package.
 *
 * Structurally identical to `@emquad/core`'s `PackageFile`, and declared here
 * rather than imported so this package depends on nothing — not even the
 * compiler it feeds.
 */
export interface PackageFile {
  /** e.g. `@preview/cetz:0.4.2` */
  spec: string;
  /** Path within the package, including `typst.toml`. */
  path: string;
  data: string | Uint8Array;
}

/**
 * Where a resolved package is allowed to come from.
 *
 * - `auto` — memory, then disk, then the network.
 * - `offline` — memory and disk only. A miss is a clean error naming what was
 *   missing, rather than a silent hang on a network that is not there.
 * - `vendor` — a checked-in directory only, for builds that must not depend on
 *   a registry being up.
 */
export type ResolutionMode = "auto" | "offline" | "vendor";

export interface ResolverOptions {
  mode?: ResolutionMode;

  /**
   * Registry base URL. Packages are fetched from
   * `{registry}/{namespace}/{name}-{version}.tar.gz`.
   */
  registry?: string;

  /**
   * Disk cache root.
   *
   * Defaults to the same location `typst-cli` uses, so a machine that has
   * already compiled with the CLI starts warm and the two do not each keep
   * their own copy.
   */
  cacheDir?: string;

  /** Directory of pre-extracted packages, used by `mode: "vendor"`. */
  vendorDir?: string;

  /** Path to `typst.lock.json`. Integrity is verified whenever it exists. */
  lockfile?: string;

  /**
   * Write newly resolved packages into the lockfile.
   *
   * Off by default: a resolver that silently rewrites the lockfile turns an
   * integrity mismatch into a lockfile update, which defeats the point.
   */
  updateLockfile?: boolean;

  /**
   * The `fetch` used for registry requests.
   *
   * Injectable so tests can run against a mock registry with no network, and
   * so a caller can supply a proxy-aware implementation. Node's global `fetch`
   * ignores `HTTPS_PROXY` before Node 24 — see the README.
   */
  fetch?: typeof globalThis.fetch;
}
