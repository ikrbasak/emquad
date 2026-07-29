# API guide

Every example here is drawn from a passing test in
[`crates/emquad-engine/tests/`](../../crates/emquad-engine/tests/). Run `cargo doc --open` for
the generated reference.

## The shape of the API

Two phases, deliberately separated by cost:

```rust
use emquad_engine::Compiler;

// Once, at startup. Everything expensive lives here.
let compiler = Compiler::builder()
    .font(std::fs::read("Inter.ttf")?)
    .source("/templates/invoice.typ", "#let invoice(n) = [Invoice #n]")
    .build()?;

// Per request. Cheap.
let output = compiler
    .compile()
    .main_source(r#"#import "/templates/invoice.typ": invoice
#invoice(42)"#)
    .run()?;

std::fs::write("invoice.pdf", &output.pdf)?;
```

`Compiler` is `Send + Sync` and cheap to clone — share one across threads. Building a second
one is not an error, but it re-parses the fonts and starts from a cold memo cache.

## The rule that matters most

**Vary content, never paths.**

```rust
// Correct. One interned path, forever.
compiler.compile().main_source(&render_invoice(order)).run()?;

// Wrong. Leaks a path per request and takes the process down at ~65k renders.
compiler.compile()
    .source(&format!("/invoice-{}.typ", order.uuid), &body)
    .main(&format!("/invoice-{}.typ", order.uuid))
    .run()?;
```

VFS paths are interned process-wide and never freed. The guard in
[`paths`](../../crates/emquad-engine/src/paths.rs) trips at 50,000 and tells you which pattern
filled the vocabulary, but the guard is a safety net — the discipline is the fix.

## `CompilerBuilder`

| Method | Purpose |
|---|---|
| `.font(data)` | Register a font file. Every face in it is added. Unparsable data is skipped. |
| `.source(path, text)` | A text file in the shared base layer. |
| `.file(path, data)` | A binary file — images, data blobs. |
| `.package_file(spec, path, data)` | A file inside a `@preview` package. |
| `.pin_rayon(bool)` | Confine typst's page-run parallelism. Default `true`; read [`03-findings.md`](03-findings.md) first. |
| `.build()` | `Err(Error::NoFonts)` if no font parsed. |

### Fonts are required

```rust
let err = Compiler::builder().build().unwrap_err();
assert_eq!(err, Error::NoFonts);
```

This is not pedantry. With no fonts, typst compiles *successfully* and emits a valid PDF with
every text run silently dropped and no diagnostics at all. A blank page is the worst way for a
font problem to reach a user.

### Mounting a `@preview` package

Mount the manifest too — typst reads `typst.toml` to find the entrypoint, and the import fails
with a file-not-found error without it. (Phase 1 discovered this the hard way; see
[`03-findings.md`](03-findings.md).)

```rust
let compiler = Compiler::builder()
    .font(font_bytes)
    .package_file("@preview/example:0.1.0", "typst.toml", r#"[package]
name = "example"
version = "0.1.0"
entrypoint = "lib.typ"
"#)
    .package_file("@preview/example:0.1.0", "lib.typ", "#let greet(n) = [Hello, #n!]")
    .build()?;
```

Fetching packages is the resolver's job, in TypeScript. This crate only stores what it is
handed — that is what keeps networking, and therefore `-sys` crates, out of the Rust tree
(hard rule 4).

## `Compile`

| Method | Purpose |
|---|---|
| `.main_source(text)` | Write `text` to `/main.typ` and use it as the main file. The normal entry point. |
| `.main(path)` | Use an existing file as the main file. |
| `.source(path, text)` | A text file in this compile's overlay. Shadows the base. |
| `.file(path, data)` | A binary file in the overlay. |
| `.clock(clock)` | Controls `datetime.today()` and the PDF timestamp. |
| `.pdf(settings)` | Export options. |
| `.reproducible(ident, instant)` | Pins the clock, `ident`, and timestamp together. |
| `.run()` | `Result<CompileOutput, Error>` |

Errors from the chained methods are held until `run()`, so the chain stays readable. The first
one wins.

### The overlay shadows the base, for one compile only

```rust
let compiler = Compiler::builder()
    .font(font_bytes)
    .source("/config.typ", "#let title = \"base\"")
    .build()?;

// Sees "overlay".
compiler.compile()
    .source("/config.typ", "#let title = \"overlay\"")
    .main_source("#import \"/config.typ\": title\n#title")
    .run()?;

// Sees "base". The overlay never touched it.
compiler.compile()
    .main_source("#import \"/config.typ\": title\n#title")
    .run()?;
```

## Reproducible output

Three things vary between runs: the clock, the document `ident`, and the PDF timestamp.
`reproducible()` pins all three.

```rust
let a = compiler.compile().main_source(src).reproducible("statement-v1", 1_785_888_000).run()?;
let b = compiler.compile().main_source(src).reproducible("statement-v1", 1_785_888_000).run()?;
assert_eq!(a.pdf, b.pdf);   // byte-identical
```

`ident` must be stable across compiles of the *same* document. An unstable identifier is worse
than none — pass `None` and let typst hash the title and author instead.

## The clock

```rust
Clock::utc()                                            // system time, reported as UTC
Clock::fixed(1_785_888_000)                             // a fixed instant — reproducible
Clock::System { offset_minutes: 330 }                   // system time at UTC+05:30
Clock::Unavailable                                      // datetime.today() errors in the document
```

**Watch the sign.** `offset_minutes` is east of UTC. JavaScript's `getTimezoneOffset()` returns
the opposite, so negate it at the boundary.

`Clock::Unavailable` is useful for proving a template does not depend on the clock: instead of
a silently wrong date, the document gets an error.

## PDF settings

```rust
PdfSettings {
    tagged: true,                     // default; accessibility. See below.
    pretty: false,
    standards: vec![PdfStandard::A_2b],
    page_ranges: None,                // requires tagged: false
    ident: None,
    creator: Creator::Auto,           // or Omit, or Custom(String)
    timestamp: PdfTimestamp::FromClock,   // or Omit, or Fixed { unix_seconds }
}
```

**`tagged` defaults to `true` and should stay that way.** Phase 0 measured +5–28% compile time
but **up to +302% output size**. The cost is size, not time. Turning it off is an accessibility
regression that users will not notice, so make it their explicit choice.

**Page ranges require `tagged: false`.** An accessibility structure tree describes the whole
document and cannot describe a subset. Typst catches this at export, after a full compile;
`PdfSettings` catches it before one starts:

```rust
Error::InvalidPdfSettings {
    message: "a tagged PDF cannot be restricted to a page range",
    hints: ["set `tagged: false` to export a page range", …],
}
```

## Errors

`Error` is structured, with a stable `code()` for the napi layer to expose as `error.code`.

| Variant | `code()` | Meaning |
|---|---|---|
| `Compile { diagnostics }` | `COMPILE_FAILED` | Typst reported fatal errors |
| `Export { diagnostics }` | `EXPORT_FAILED` | Compiled, but PDF export failed — usually standards conformance |
| `NoFonts` | `NO_FONTS` | No fonts registered |
| `PathVocabularyExhausted { … }` | `PATH_VOCABULARY_EXHAUSTED` | The interner guard tripped |
| `InvalidPath { … }` | `INVALID_PATH` | Not a valid virtual path (e.g. escapes the root) |
| `InvalidPackageSpec { … }` | `INVALID_PACKAGE_SPEC` | Unparsable package specification |
| `MainNotFound { path }` | `MAIN_NOT_FOUND` | The main file is in neither VFS layer |
| `InvalidPdfSettings { … }` | `INVALID_PDF_SETTINGS` | Mutually incompatible export options |
| `Panic { message }` | `PANIC` | A Rust panic was caught at the compile boundary — always a bug |

`Display` exists for logs and test output. **Do not parse it** — match on the variant or on
`code()`.

## Diagnostics

```rust
pub struct Diagnostic {
    pub severity: Severity,             // Error | Warning
    pub message: String,
    pub position: Option<Position>,     // None when detached
    pub hints: Vec<Hint>,               // each with its own optional position
    pub trace: Vec<TraceFrame>,
}

pub struct Position { pub file: String, pub line: u32, pub column: u32 }  // both 1-based
```

`file` is a VFS path: `/main.typ`, or `@preview/cetz:0.4.2/lib.typ` for package files.
`Diagnostic::file()`, `line()`, and `column()` exist so callers do not have to unwrap
`position`.

**Read the warnings on success too.** They are the most likely place a silently-wrong document
announces itself:

```rust
let output = compiler.compile().main_source(src).run()?;
for warning in &output.warnings {
    eprintln!("{warning}");   // "warning at /main.typ:1:1: … \n  hint: …"
}
```

## Memory

```rust
use emquad_engine::cache;

// Between compiles, from the pool — never inside one.
cache::evict(cache::RECOMMENDED_MAX_AGE);   // 16
```

`comemo` is process-global and unbounded. Phase 0, over 100,000 compiles:

| Policy | µs/doc | RSS growth |
|---|---|---|
| None | 636.9 | **+902 MB**, oscillating 0.68–1.14 GB |
| `evict(2)` | 706.4 (−9.8%) | +8.5 MB |
| `evict(16)` | 676.7 (−5.9%) | +13.9 MB |

## Metrics

```rust
let stats = emquad_engine::paths::stats();
// PathStats { interned, tracked, limit: 50_000, cap: 65_535 }
```

`interned` is typst's whole interner including paths it created itself; `tracked` is only what
went through our wrapper. Export `interned / limit` — it is the number that predicts a crash.

`paths::set_limit(n)` lowers the guard; raising it past `cap` is refused, because beyond that
point the guard could not fire before typst's own panic.
