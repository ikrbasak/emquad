/** Parsing, formatting, and finding package specs in typst source. */

export interface PackageSpec {
  /** `preview` for the public registry. */
  namespace: string;
  name: string;
  /** Exact semver. Typst package imports never carry a range. */
  version: string;
}

/**
 * `@preview/cetz:0.4.2`.
 *
 * Anchored, and strict about the shape. Typst itself accepts only this form,
 * so anything looser here would resolve a package the compiler could not then
 * import.
 */
const SPEC = /^@([a-z0-9-]+)\/([a-z0-9-]+):(\d+\.\d+\.\d+)$/u;

/**
 * The same pattern, unanchored, for scanning source text.
 *
 * A regex prescan rather than a parse. It has to be, given the constraint this
 * whole package works around: typst's `World::file` is synchronous, so a
 * package cannot be fetched during a compile. Something has to know what to
 * download *before* compiling, and short of embedding a typst parser that
 * means reading the import strings out of the text.
 *
 * It over-matches — a spec inside a comment or a string literal counts — and
 * that is the right direction to be wrong in. A spurious fetch costs one
 * cached download; a missed one fails the compile.
 */
const SCAN = /@([a-z0-9-]+)\/([a-z0-9-]+):(\d+\.\d+\.\d+)/gu;

export function parseSpec(spec: string): PackageSpec {
  const match = SPEC.exec(spec);
  if (!match) {
    throw new Error(
      `invalid package spec ${JSON.stringify(spec)}; expected "@namespace/name:0.0.0"`,
    );
  }
  return { namespace: match[1]!, name: match[2]!, version: match[3]! };
}

export function formatSpec(spec: PackageSpec): string {
  return `@${spec.namespace}/${spec.name}:${spec.version}`;
}

/** Every distinct package spec mentioned in the given text. */
export function scanSpecs(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(SCAN)) found.add(match[0]);
  return [...found];
}
