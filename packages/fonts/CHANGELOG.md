# @emquad/fonts

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
