# @emquad/typst-binding

## 0.0.2

### Patch Changes

- 60cdde2: Fix an undeclared type in the published TypeScript declarations.

  `@emquad/typst-binding`'s `index.d.ts` referenced a `FileData` type that was
  never declared, so any TypeScript consumer saw two `TS2304: Cannot find name
'FileData'` errors from a file they did not write. It reached users of
  `@emquad/core` too, because core's declarations import from the binding.

  `skipLibCheck` defaults to `false` in TypeScript, so a stock `tsconfig.json`
  hits this; only projects that had turned it on were unaffected.

  The field is now declared as `Record<string, string | Uint8Array>`, which is
  what it always accepted at runtime — this is a declarations fix with no
  behavioural change.

## 0.0.1

### Patch Changes

- Initial release.

  Typst PDF generation for Node: a VFS in, a PDF out. `@emquad/core` carries the
  API and both pools, `@emquad/fonts` the optional default faces, and
  `@emquad/resolver` the `@preview` registry client. Native bindings ship
  prebuilt per platform as `@emquad/typst-binding-<platform>`, resolved through
  `optionalDependencies` with no postinstall download.

  Built against Typst 0.15.1, which is pinned exactly — it is pre-1.0 and breaks
  across minor releases, so a Typst bump is always at least a minor bump here.
