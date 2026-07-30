---
"@emquad/typst-binding": patch
"@emquad/core": patch
---

Fix an undeclared type in the published TypeScript declarations.

`@emquad/typst-binding`'s `index.d.ts` referenced a `FileData` type that was
never declared, so any TypeScript consumer saw two `TS2304: Cannot find name
'FileData'` errors from a file they did not write. It reached users of
`@emquad/core` too, because core's declarations import from the binding.

`skipLibCheck` defaults to `false` in TypeScript, so a stock `tsconfig.json`
hits this; only projects that had turned it on were unaffected.

The field is now declared as `Record<string, string | Uint8Array>`, which is
what it always accepted at runtime — this is a declarations fix with no
behavioural change.
