import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { defaultCacheDir, readPackage, writePackage } from "#/cache.ts";
import { ResolverError } from "#/errors.ts";
import { integrityOf } from "#/integrity.ts";
import { emptyLockfile, type Lockfile, readLockfile, writeLockfile } from "#/lockfile.ts";
import { formatSpec, type PackageSpec, parseSpec, scanSpecs } from "#/spec.ts";
import { extractTarGz, stripCommonPrefix } from "#/tar.ts";
import type { PackageFile, ResolutionMode, ResolverOptions } from "#/types.ts";

export const DEFAULT_REGISTRY = "https://packages.typst.org";

/**
 * Resolves `@preview` packages into files `@emquad/core` can mount.
 *
 * ## Why this is TypeScript and not Rust
 *
 * All networking in this project lives here. That is what keeps the Rust
 * dependency tree free of `-sys` crates — no OpenSSL, no bindgen, no cmake —
 * which is in turn what makes building for fourteen os/arch targets affordable.
 * Moving a fetch into Rust would cost the whole matrix.
 *
 * ## Why resolution happens before compiling
 *
 * Typst's `World::file` is synchronous. A package cannot be downloaded during a
 * compile, so something must know what to download beforehand. This resolver
 * prescans source text for import specs, fetches those, then prescans *their*
 * sources for transitive imports, until nothing new appears.
 *
 * ## The caching claim
 *
 * The network is hit **once per package version, ever** — not once per compile.
 * Memory, then the disk cache shared with `typst-cli`, then the registry.
 * {@link networkFetches} exists so that claim is assertable rather than
 * asserted.
 */
export class Resolver {
  readonly #mode: ResolutionMode;
  readonly #registry: string;
  readonly #cacheDir: string;
  readonly #vendorDir: string | undefined;
  readonly #lockfilePath: string | undefined;
  readonly #updateLockfile: boolean;
  readonly #fetch: typeof globalThis.fetch;

  readonly #memory = new Map<string, PackageFile[]>();
  /** Concurrent requests for the same package share one download. */
  readonly #inflight = new Map<string, Promise<PackageFile[]>>();

  #lock: Lockfile | undefined;
  #networkFetches = 0;

  constructor(options: ResolverOptions = {}) {
    this.#mode = options.mode ?? "auto";
    this.#registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/u, "");
    this.#cacheDir = options.cacheDir ?? defaultCacheDir();
    this.#vendorDir = options.vendorDir;
    this.#lockfilePath = options.lockfile;
    this.#updateLockfile = options.updateLockfile ?? false;
    this.#fetch = options.fetch ?? globalThis.fetch;

    if (this.#mode === "vendor" && !this.#vendorDir) {
      throw new ResolverError("INVALID_SPEC", 'mode "vendor" requires vendorDir');
    }
  }

  /**
   * How many times the registry has actually been contacted.
   *
   * The correctness claim of the whole caching design is that this stays flat
   * across compiles. Assert on it.
   */
  get networkFetches(): number {
    return this.#networkFetches;
  }

  /**
   * Every package the given sources need, transitively.
   *
   * Pass the document source and any templates from the base VFS layer. The
   * result goes straight into `new Compiler({ packages })`.
   */
  async resolve(sources: string | readonly string[]): Promise<PackageFile[]> {
    const pending = [
      ...new Set(
        (typeof sources === "string" ? [sources] : sources).flatMap((text) => scanSpecs(text)),
      ),
    ];
    const seen = new Set<string>();
    const out: PackageFile[] = [];

    while (pending.length > 0) {
      const spec = pending.shift()!;
      if (seen.has(spec)) continue;
      seen.add(spec);

      const files = await this.fetch(spec);
      out.push(...files);

      // A package's own sources can import further packages, and nothing else
      // reports that dependency — typst manifests do not list it in a form
      // worth trusting. Scanning what was just downloaded is what makes the
      // resolution transitive.
      for (const file of files) {
        if (!file.path.endsWith(".typ")) continue;
        const text =
          typeof file.data === "string" ? file.data : Buffer.from(file.data).toString("utf8");
        for (const found of scanSpecs(text)) {
          if (!seen.has(found)) pending.push(found);
        }
      }
    }

    return out;
  }

  /** Resolve exactly one package, without following its imports. */
  async fetch(spec: string): Promise<PackageFile[]> {
    const cached = this.#memory.get(spec);
    if (cached) return cached;

    const inflight = this.#inflight.get(spec);
    // Without this, N concurrent compiles needing the same package would each
    // download it — the exact "once per version" claim, broken by concurrency.
    if (inflight) return await inflight;

    const promise = this.#load(parseSpec(spec)).finally(() => this.#inflight.delete(spec));
    this.#inflight.set(spec, promise);
    return await promise;
  }

  /** Persist the lockfile. No-op unless `lockfile` and `updateLockfile` are set. */
  async save(): Promise<void> {
    if (!this.#lockfilePath || !this.#updateLockfile || !this.#lock) return;
    await writeLockfile(this.#lockfilePath, this.#lock);
  }

  async #load(spec: PackageSpec): Promise<PackageFile[]> {
    const key = formatSpec(spec);

    if (this.#mode === "vendor") {
      const vendored = await this.#readVendored(spec);
      if (!vendored) {
        throw new ResolverError(
          "PACKAGE_NOT_CACHED",
          `${key} is not in the vendor directory (${this.#vendorDir!})`,
          { spec: key },
        );
      }
      return await this.#accept(key, vendored);
    }

    const onDisk = await readPackage(this.#cacheDir, spec);
    if (onDisk) {
      // Verified here, not only on download. A disk cache is shared with
      // `typst-cli` and lives across upgrades, so it is the path most likely to
      // have drifted and the one an integrity check is actually for.
      return await this.#accept(key, onDisk);
    }

    if (this.#mode === "offline") {
      throw new ResolverError(
        "PACKAGE_NOT_CACHED",
        `${key} is not in the cache (${this.#cacheDir}) and mode is "offline"`,
        { spec: key },
      );
    }

    const downloaded = await this.#download(spec);
    const accepted = await this.#accept(key, downloaded);
    // Written only after integrity passes, so a mismatched package is never
    // installed anywhere a later run could pick it up as a cache hit.
    await writePackage(this.#cacheDir, spec, accepted);
    return accepted;
  }

  async #download(spec: PackageSpec): Promise<PackageFile[]> {
    const key = formatSpec(spec);
    const url = `${this.#registry}/${spec.namespace}/${spec.name}-${spec.version}.tar.gz`;

    this.#networkFetches += 1;

    let response: Response;
    try {
      response = await this.#fetch(url);
    } catch (cause) {
      throw new ResolverError("NETWORK_ERROR", `could not reach ${url}: ${String(cause)}`, {
        spec: key,
        cause,
      });
    }

    if (!response.ok) {
      throw new ResolverError(
        "PACKAGE_NOT_FOUND",
        `${key} — ${this.#registry} returned ${response.status} ${response.statusText}`,
        { spec: key },
      );
    }

    let entries;
    try {
      entries = stripCommonPrefix(extractTarGz(Buffer.from(await response.arrayBuffer())));
    } catch (cause) {
      throw new ResolverError("INVALID_PACKAGE", `${key} is not a readable .tar.gz`, {
        spec: key,
        cause,
      });
    }

    const files = entries.map((entry) => ({ spec: key, path: entry.path, data: entry.data }));

    // Typst reads the manifest to find the entrypoint. A package without one
    // fails at import time with a file-not-found naming a path the user never
    // wrote, which is a genuinely baffling error to receive — so it is caught
    // at download instead.
    if (!files.some((file) => file.path === "typst.toml")) {
      throw new ResolverError("INVALID_PACKAGE", `${key} has no typst.toml manifest`, {
        spec: key,
      });
    }

    return files;
  }

  /** Verify against the lockfile, memoize, and return. */
  async #accept(key: string, files: PackageFile[]): Promise<PackageFile[]> {
    if (this.#lockfilePath) {
      this.#lock ??= await readLockfile(this.#lockfilePath);
      const recorded = this.#lock.packages[key];
      const actual = integrityOf(files);

      if (recorded && recorded.integrity !== actual) {
        throw new ResolverError(
          "INTEGRITY_MISMATCH",
          `${key} does not match the lockfile: expected ${recorded.integrity}, got ${actual}. ` +
            "Either the registry served different bytes or the cache is corrupt; nothing has " +
            "been installed.",
          { spec: key },
        );
      }

      if (!recorded && this.#updateLockfile) {
        this.#lock.packages[key] = { integrity: actual, files: files.length };
      }
    }

    this.#memory.set(key, files);
    return files;
  }

  async #readVendored(spec: PackageSpec): Promise<PackageFile[] | undefined> {
    const dir = join(this.#vendorDir!, spec.namespace, spec.name, spec.version);
    try {
      if (!(await stat(dir)).isDirectory()) return undefined;
    } catch {
      return undefined;
    }

    const key = formatSpec(spec);
    const walk = async (from: string): Promise<string[]> => {
      const found: string[] = [];
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const full = join(from, entry.name);
        if (entry.isDirectory()) found.push(...(await walk(full)));
        else if (entry.isFile()) found.push(relative(dir, full));
      }
      return found;
    };

    const paths = await walk(dir);
    if (!paths.includes("typst.toml")) return undefined;

    return await Promise.all(
      paths.map(async (path) => ({
        spec: key,
        path: path.split(sep).join("/"),
        data: await readFile(join(dir, path)),
      })),
    );
  }
}

/** A fresh, empty lockfile, for callers writing one from scratch. */
export { emptyLockfile };
