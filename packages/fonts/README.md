# @emquad/fonts

The default [Typst](https://typst.app) font set for
[`@emquad/core`](https://www.npmjs.com/package/@emquad/core), shipped byte-for-byte.

```sh
npm install @emquad/fonts
```

```ts
import { Compiler } from "@emquad/core";
import { defaultFonts } from "@emquad/fonts";

const compiler = new Compiler({ fonts: defaultFonts });
```

17 faces, 9.3 MB, taken verbatim from `typst-assets` 0.15.1.

## ⚠ This package is not MIT

The rest of emquad is. These files carry **four** licenses:

| Files | License |
|---|---|
| `LibertinusSerif-*.otf` (6) | SIL Open Font License 1.1 |
| `NewCMMath-*.otf` (3), `NewCM10-{Bold,Italic,BoldItalic}.otf` (3) | GUST Font License (LPPL 1.3c or later) |
| `NewCM10-Regular.otf` (1) | **GPL-3.0-or-later**, with Font and Distribution Exceptions |
| `DejaVuSansMono*.ttf` (4) | Bitstream Vera / DejaVu |

Full texts ship in `licenses/NOTICE`.

**The Font Exception means a PDF that embeds these fonts is not thereby GPL** — your documents
are unaffected. The Distribution Exception is what lets a permissively licensed program carry
`NewCM10-Regular.otf`, and it is void the moment the glyphs or glyph-set change:

> If however you distribute a copy of the fonts that modifies either the glyphs (one or more) or
> the glyph-set by adding or removing glyphs, this exception is invalidated and your program has
> to follow GPL version 3 (or later).

So: **never subset, re-encode, or rewrite these files.** 9.3 MB is a tempting target and
subsetting is the obvious way to shrink it — doing so would relicense this package as GPL-3.

## Shrinking the payload, safely

Drop whole families instead. That is a packaging choice; subsetting is a license change.

```ts
import { fontsExcept, fontsFor } from "@emquad/fonts";

fontsFor("libertinus-serif");                     // 6 faces
fontsFor("libertinus-serif", "dejavu-sans-mono"); // 10 faces
fontsExcept("new-computer-modern");               // drop the math family
```

Families are `"libertinus-serif"`, `"new-computer-modern"`, and `"dejavu-sans-mono"`.

**Keep a serif family.** Typst emits no diagnostic when SVG text names an unregistered font, and
with no serif face available the text renders as *nothing* — a valid PDF with the glyphs simply
missing.

## Descriptors, not bytes

`defaultFonts` yields `{ file }` descriptors rather than buffers. Nothing is read until a
`Compiler` is built, and under `pool.mode: "process"` the path is what crosses the IPC channel —
each worker opens the files itself, avoiding 77 MB of copying at eight workers.

## Metadata

```ts
import { MANIFEST, TOTAL_BYTES, TYPST_ASSETS_VERSION } from "@emquad/fonts";

MANIFEST[0]; // { file, license, bytes, sha256 }
```

The checksums are not decoration: the test suite verifies every shipped file against both its
recorded hash and its `typst-assets` original, which is what turns "ship these byte-for-byte"
from a rule someone has to remember into one the build enforces.
