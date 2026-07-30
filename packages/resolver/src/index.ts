/**
 * `@emquad/resolver` — `@preview` package resolution for `@emquad/core`.
 *
 * ```ts
 * import { Compiler } from "@emquad/core";
 * import { defaultFonts } from "@emquad/fonts";
 * import { Resolver } from "@emquad/resolver";
 *
 * const source = '#import "@preview/cetz:0.4.2": canvas\n#canvas({})';
 *
 * const resolver = new Resolver({ lockfile: "typst.lock.json" });
 * const packages = await resolver.resolve(source);
 *
 * const compiler = new Compiler({ fonts: defaultFonts, packages });
 * const { pdf } = await compiler.document().source(source).compile();
 * ```
 *
 * Resolve once, at startup, and reuse the `Compiler`. The network is contacted
 * once per package version and never per compile.
 *
 * ## Proxies
 *
 * Node's global `fetch` ignores `HTTPS_PROXY` before Node 24. On Node 24 and
 * later, set `NODE_USE_ENV_PROXY=1`. On Node 22, pass a proxy-aware `fetch`
 * through {@link ResolverOptions.fetch} — that option exists for exactly this,
 * and for pointing tests at a mock registry.
 *
 * @packageDocumentation
 */

export { defaultCacheDir } from "#/cache.ts";
export { ResolverError } from "#/errors.ts";
export type { ResolverErrorCode } from "#/errors.ts";
export { integrityOf } from "#/integrity.ts";
export { emptyLockfile, LOCKFILE_VERSION, readLockfile, writeLockfile } from "#/lockfile.ts";
export type { Lockfile, LockEntry } from "#/lockfile.ts";
export { DEFAULT_REGISTRY, Resolver } from "#/resolver.ts";
export { formatSpec, parseSpec, scanSpecs } from "#/spec.ts";
export type { PackageSpec } from "#/spec.ts";
export { extractTar, extractTarGz, stripCommonPrefix } from "#/tar.ts";
export type { TarEntry } from "#/tar.ts";
export type { PackageFile, ResolutionMode, ResolverOptions } from "#/types.ts";
