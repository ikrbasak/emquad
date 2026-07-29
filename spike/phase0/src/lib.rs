//! Shared spike scaffolding: a minimal in-memory `World` over a VFS.
//! Throwaway code — Phase 0 only.

use std::collections::HashMap;
use std::sync::OnceLock;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

pub struct VfsWorld {
    pub library: LazyHash<Library>,
    pub book: LazyHash<FontBook>,
    pub fonts: Vec<Font>,
    pub main: FileId,
    pub files: HashMap<FileId, Bytes>,
}

impl World for VfsWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }
    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }
    fn main(&self) -> FileId {
        self.main
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        let b = self.file(id)?;
        let t = std::str::from_utf8(&b).map_err(|_| FileError::InvalidUtf8)?;
        Ok(Source::new(id, t.to_string()))
    }
    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files
            .get(&id)
            .cloned()
            .ok_or_else(|| FileError::NotFound(std::path::PathBuf::from("missing")))
    }
    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }
    fn today(&self, _: Option<Duration>) -> Option<Datetime> {
        Datetime::from_ymd(2026, 7, 29)
    }
}

pub fn vfs_id(p: &str) -> FileId {
    FileId::new(RootedPath::new(
        VirtualRoot::Project,
        VirtualPath::new(p).unwrap(),
    ))
}

/// Fonts and `FontBook` are expensive to build and must be shared across
/// worlds — hard rule 6. Built once, cloned cheaply (`Font` is `Arc`-backed).
fn font_set() -> &'static (FontBook, Vec<Font>) {
    static FONTS: OnceLock<(FontBook, Vec<Font>)> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut fonts = Vec::new();
        let mut book = FontBook::new();
        for data in typst_assets::fonts() {
            for f in Font::iter(Bytes::new(data.to_vec())) {
                book.push(f.info().clone());
                fonts.push(f);
            }
        }
        (book, fonts)
    })
}

impl VfsWorld {
    pub fn new() -> Self {
        let (book, fonts) = font_set();
        Self {
            library: LazyHash::new(<Library as LibraryExt>::default()),
            book: LazyHash::new(book.clone()),
            fonts: fonts.clone(),
            main: vfs_id("main.typ"),
            files: HashMap::new(),
        }
    }

    pub fn set_main_source(&mut self, src: &str) {
        let main = self.main;
        self.files.insert(main, Bytes::new(src.as_bytes().to_vec()));
    }
}

impl Default for VfsWorld {
    fn default() -> Self {
        Self::new()
    }
}

/// The Phase 0 reference document: an invoice with color, a table with a
/// per-row fill callback, and a gradient. `{N}` is substituted per iteration
/// so successive compiles are genuinely distinct.
pub const INVOICE: &str = r##"
#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(fill: rgb("#1a3a5a"))
= Invoice {N}
#table(
  columns: 3, stroke: 0.5pt + rgb("#888888"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  table.header([*Item*], [*Qty*], [*Price*]),
  [Widget], [{N}], [$12.00$], [Gadget], [7], [$45.50$],
)
#rect(fill: gradient.linear(rgb("#ff0000"), rgb("#0000ff")), width: 100%, height: 2cm)
"##;

pub fn invoice(n: usize) -> String {
    INVOICE.replace("{N}", &n.to_string())
}

/// A multi-page report. `typst-layout` parallelizes *page runs* across the
/// global rayon pool (`typst-layout-0.15.1/src/pages/mod.rs:185`), so a
/// single-page document never exercises that path. Anything measuring
/// contention or oversubscription must use this one.
pub const REPORT: &str = r##"
#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(fill: rgb("#1a3a5a"))
= Report {N}
#for i in range(60) [
  == Section {N}-#i
  #lorem(40)
  #table(
    columns: 3, stroke: 0.5pt + rgb("#888888"),
    fill: (_, y) => if y == 0 { rgb("#eeeeff") },
    table.header([*Item*], [*Qty*], [*Price*]),
    [Widget], [#i], [$12.00$], [Gadget], [7], [$45.50$],
  )
  #rect(fill: gradient.linear(rgb("#ff0000"), rgb("#0000ff")), width: 100%, height: 1cm)
]
"##;

pub fn report(n: usize) -> String {
    REPORT.replace("{N}", &n.to_string())
}

/// `parallelize` iterates *page runs* (`Item::Run`), which are created by page
/// re-configuration — not by page count. A normal document has exactly one run,
/// so rayon never engages. This document forces 40 runs, which is the only
/// shape that can oversubscribe the global rayon pool from our worker threads.
pub const MULTIRUN: &str = r##"
= Multi-run {N}
#for i in range(40) [
  #set page(width: 210mm, height: 297mm, margin: (x: 20mm + i * 0.1mm, y: 20mm))
  == Run {N}-#i
  #lorem(60)
]
"##;

pub fn multirun(n: usize) -> String {
    MULTIRUN.replace("{N}", &n.to_string())
}

/// Which reference document to use, from `PHASE0_DOC`
/// (`invoice` | `report` | `multirun`).
pub fn doc_for(n: usize) -> String {
    match std::env::var("PHASE0_DOC").as_deref() {
        Ok("report") => report(n),
        Ok("multirun") => multirun(n),
        _ => invoice(n),
    }
}

pub fn doc_name() -> String {
    std::env::var("PHASE0_DOC").unwrap_or_else(|_| "invoice".into())
}

/// Resident set size in KiB, via `ps`. Good enough for sampling a curve.
pub fn rss_kib() -> u64 {
    let pid = std::process::id();
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .expect("ps failed");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or(0)
}

/// Compile the given source to PDF, returning the byte length.
pub fn compile_to_pdf(world: &VfsWorld, opts: &typst_pdf::PdfOptions) -> usize {
    let doc = typst::compile::<typst_layout::PagedDocument>(world)
        .output
        .expect("compile failed");
    typst_pdf::pdf(&doc, opts).expect("pdf export failed").len()
}
