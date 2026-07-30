import { homedir, platform } from "node:os";
import { join, relative, sep } from "node:path";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import { formatSpec, type PackageSpec } from "#/spec.ts";
import type { PackageFile } from "#/types.ts";

/**
 * The directory `typst-cli` uses for its package cache.
 *
 * Sharing it is the point. A machine that has already compiled anything with
 * the CLI starts warm, and neither tool keeps a second copy of the same
 * packages. These paths mirror the `dirs` crate's `cache_dir()`, which is what
 * typst calls.
 */
export function defaultCacheDir(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Caches", "typst", "packages");
    case "win32":
      return join(
        process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"),
        "typst",
        "packages",
      );
    default:
      return join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "typst", "packages");
  }
}

/** `{root}/preview/cetz/0.4.2` */
export function packageDir(root: string, spec: PackageSpec): string {
  return join(root, spec.namespace, spec.name, spec.version);
}

async function walk(dir: string, base: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(full, base)));
    } else if (entry.isFile()) {
      found.push(relative(base, full));
    }
  }
  return found;
}

/**
 * Read an extracted package off disk, or `undefined` if it is not there.
 *
 * A directory with no `typst.toml` counts as absent rather than as a package
 * with a missing manifest. Typst reads the manifest to find the entrypoint, so
 * without it an import fails with a file-not-found naming a file the user never
 * wrote — better to treat a half-written cache entry as a miss and refetch.
 */
export async function readPackage(
  root: string,
  spec: PackageSpec,
): Promise<PackageFile[] | undefined> {
  const dir = packageDir(root, spec);
  try {
    if (!(await stat(dir)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const paths = await walk(dir, dir);
  if (!paths.includes("typst.toml")) return undefined;

  const formatted = formatSpec(spec);
  return await Promise.all(
    paths.map(async (path) => ({
      spec: formatted,
      // Always forward slashes: typst's VFS paths are not OS paths, and a
      // Windows-shaped `lib\\util.typ` would never match an import.
      path: path.split(sep).join("/"),
      data: await readFile(join(dir, path)),
    })),
  );
}

/**
 * Write an extracted package into the cache.
 *
 * Staged through a temporary directory and renamed into place, so a crash
 * mid-write cannot leave a partial package that later reads would treat as
 * complete. `readPackage` also checks for `typst.toml`, which covers the case
 * where a rename is not atomic across the filesystem.
 */
export async function writePackage(
  root: string,
  spec: PackageSpec,
  files: readonly PackageFile[],
): Promise<void> {
  const target = packageDir(root, spec);
  const staging = `${target}.tmp-${process.pid}`;

  await rm(staging, { recursive: true, force: true });
  for (const file of files) {
    const path = join(staging, ...file.path.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, file.data);
  }

  await mkdir(join(target, ".."), { recursive: true });
  await rm(target, { recursive: true, force: true });
  try {
    await rename(staging, target);
  } catch {
    // A concurrent resolver may have won the race and populated the directory.
    // That is a success, not a conflict — the content is identical.
    await rm(staging, { recursive: true, force: true });
  }
}
