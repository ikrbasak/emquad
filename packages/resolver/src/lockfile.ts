import { readFile, writeFile } from "node:fs/promises";

export const LOCKFILE_VERSION = 1;

export interface LockEntry {
  /** `sha256-<base64>` over the extracted files. See `integrityOf`. */
  integrity: string;
  /** File count, for a human reading the diff. Not part of verification. */
  files: number;
}

export interface Lockfile {
  version: number;
  packages: Record<string, LockEntry>;
}

export function emptyLockfile(): Lockfile {
  return { version: LOCKFILE_VERSION, packages: {} };
}

export async function readLockfile(path: string): Promise<Lockfile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return emptyLockfile();
  }

  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} is not a valid lockfile`);
  }

  const lock = parsed as Partial<Lockfile>;
  if (lock.version !== LOCKFILE_VERSION) {
    throw new Error(`${path} has version ${String(lock.version)}, expected ${LOCKFILE_VERSION}`);
  }
  return { version: LOCKFILE_VERSION, packages: lock.packages ?? {} };
}

/** Written with sorted keys, so a diff shows what changed and nothing else. */
export async function writeLockfile(path: string, lock: Lockfile): Promise<void> {
  const packages: Record<string, LockEntry> = {};
  for (const key of Object.keys(lock.packages).toSorted()) {
    packages[key] = lock.packages[key]!;
  }
  await writeFile(path, `${JSON.stringify({ version: lock.version, packages }, null, 2)}\n`);
}
