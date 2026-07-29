//! JS types in, engine types out.
//!
//! Everything here runs on the **JS thread**, before a job reaches the pool.
//! That is not incidental: `Uint8Array` borrows V8-owned memory and is not
//! `Send`, so the request has to be copied into owned data before it can cross
//! a thread boundary. Doing that conversion up front also means argument errors
//! surface synchronously, before a queue slot is spent.

use std::collections::HashMap;

use emquad_engine::{Clock, Creator, PageRange, PdfSettings, PdfStandard, PdfTimestamp};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// A file's contents, as accepted from JS: `string | Buffer | Uint8Array`.
/// `Buffer` needs no separate arm — it *is* a `Uint8Array`.
pub type FileData = Either<String, Uint8Array>;

/// Owned, `Send`-able file contents, ready for a worker thread.
pub enum OwnedData {
    Text(String),
    Bytes(Vec<u8>),
}

pub fn own(data: FileData) -> OwnedData {
    match data {
        Either::A(text) => OwnedData::Text(text),
        Either::B(bytes) => OwnedData::Bytes(bytes.to_vec()),
    }
}

pub fn own_all(files: Option<HashMap<String, FileData>>) -> Vec<(String, OwnedData)> {
    files.unwrap_or_default().into_iter().map(|(path, data)| (path, own(data))).collect()
}

#[napi(object)]
pub struct PackageFile {
    /// e.g. `@preview/cetz:0.4.2`
    pub spec: String,
    /// Path within the package. Mount `typst.toml` too — typst reads it to find
    /// the entrypoint, and an import fails without it.
    pub path: String,
    pub data: Either<String, Uint8Array>,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct ClockOptions {
    /// Unix seconds. Pins the date, making output reproducible.
    pub fixed: Option<f64>,
    /// Minutes **east** of UTC. Note the sign: JavaScript's
    /// `getTimezoneOffset()` returns the opposite, so negate it.
    pub offset_minutes: Option<i32>,
    /// Make `datetime.today()` an error in the document rather than a date.
    pub unavailable: Option<bool>,
}

impl ClockOptions {
    pub fn to_clock(&self) -> Clock {
        if self.unavailable == Some(true) {
            return Clock::Unavailable;
        }
        let offset_minutes = self.offset_minutes.unwrap_or(0);
        match self.fixed {
            Some(seconds) => Clock::Fixed { unix_seconds: seconds as i64, offset_minutes },
            None => Clock::System { offset_minutes },
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct PageRangeOptions {
    /// 1-based, inclusive. Omit for "from the first page".
    pub start: Option<u32>,
    /// 1-based, inclusive. Omit for "to the last page".
    pub end: Option<u32>,
}

#[napi(object)]
#[derive(Default)]
pub struct PdfOptions {
    /// Emit a tagged (accessible) PDF. Defaults to `true`, as upstream does.
    /// The cost is size — Phase 0 measured up to +302% — not time.
    pub tagged: Option<bool>,
    pub pretty: Option<bool>,
    /// SPDX-ish standard names: `1.4`–`2.0`, `a-1b`…`a-4e`, `ua-1`.
    pub standards: Option<Vec<String>>,
    /// Requires `tagged: false`.
    pub page_ranges: Option<Vec<PageRangeOptions>>,
    /// Must be stable across compiles of the same document, or omitted.
    pub ident: Option<String>,
    /// A string, or `false` to omit the field.
    pub creator: Option<Either<String, bool>>,
    /// Unix seconds, or `false` to omit the timestamp.
    pub timestamp: Option<Either<f64, bool>>,
}

impl PdfOptions {
    pub fn to_settings(&self) -> Result<PdfSettings> {
        let mut settings = PdfSettings::default();

        if let Some(tagged) = self.tagged {
            settings.tagged = tagged;
        }
        if let Some(pretty) = self.pretty {
            settings.pretty = pretty;
        }
        if let Some(names) = &self.standards {
            settings.standards =
                names.iter().map(|name| standard(name)).collect::<Result<Vec<_>>>()?;
        }
        if let Some(ranges) = &self.page_ranges {
            settings.page_ranges = Some(
                ranges
                    .iter()
                    .map(|range| PageRange {
                        start: range.start.map(|n| n as usize),
                        end: range.end.map(|n| n as usize),
                    })
                    .collect(),
            );
        }
        settings.ident = self.ident.clone();
        settings.creator = match &self.creator {
            None => Creator::Auto,
            Some(Either::B(false)) => Creator::Omit,
            Some(Either::B(true)) => Creator::Auto,
            Some(Either::A(name)) => Creator::Custom(name.clone()),
        };
        settings.timestamp = match self.timestamp {
            None => PdfTimestamp::FromClock,
            Some(Either::B(false)) => PdfTimestamp::Omit,
            Some(Either::B(true)) => PdfTimestamp::FromClock,
            Some(Either::A(seconds)) => PdfTimestamp::Fixed { unix_seconds: seconds as i64 },
        };

        Ok(settings)
    }
}

/// Parse a PDF standard name.
///
/// Spelled out rather than derived from typst's serde names, because this crate
/// does not depend on serde and because an unknown name should fail with a list
/// of what is accepted rather than a deserialization error.
fn standard(name: &str) -> Result<PdfStandard> {
    Ok(match name.to_ascii_lowercase().as_str() {
        "1.4" => PdfStandard::V_1_4,
        "1.5" => PdfStandard::V_1_5,
        "1.6" => PdfStandard::V_1_6,
        "1.7" => PdfStandard::V_1_7,
        "2.0" => PdfStandard::V_2_0,
        "a-1b" => PdfStandard::A_1b,
        "a-1a" => PdfStandard::A_1a,
        "a-2b" => PdfStandard::A_2b,
        "a-2u" => PdfStandard::A_2u,
        "a-2a" => PdfStandard::A_2a,
        "a-3b" => PdfStandard::A_3b,
        "a-3u" => PdfStandard::A_3u,
        "a-3a" => PdfStandard::A_3a,
        "a-4" => PdfStandard::A_4,
        "a-4f" => PdfStandard::A_4f,
        "a-4e" => PdfStandard::A_4e,
        "ua-1" => PdfStandard::Ua_1,
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "unknown PDF standard `{other}`; expected one of 1.4, 1.5, 1.6, 1.7, \
                     2.0, a-1b, a-1a, a-2b, a-2u, a-2a, a-3b, a-3u, a-3a, a-4, a-4f, a-4e, ua-1"
                ),
            ));
        }
    })
}

// --- Results ------------------------------------------------------------

#[napi(object)]
#[derive(Debug, Clone)]
pub struct Position {
    /// A VFS path: `/main.typ`, or `@preview/cetz:0.4.2/lib.typ`.
    pub file: String,
    /// 1-based.
    pub line: u32,
    /// 1-based, counted in characters rather than bytes.
    pub column: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct Hint {
    pub message: String,
    /// A hint can point at different code than the diagnostic it belongs to.
    pub position: Option<Position>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct TraceFrame {
    pub message: String,
    pub position: Option<Position>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct Diagnostic {
    /// `"error"` or `"warning"`.
    pub severity: String,
    pub message: String,
    /// Absent when the diagnostic does not point into any file.
    pub position: Option<Position>,
    pub hints: Vec<Hint>,
    pub trace: Vec<TraceFrame>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CompileFailure {
    /// A stable machine-readable code: `COMPILE_FAILED`, `NO_FONTS`,
    /// `PATH_VOCABULARY_EXHAUSTED`, and so on. Branch on this, never on
    /// `message`.
    pub code: String,
    pub message: String,
    pub diagnostics: Vec<Diagnostic>,
}

/// The outcome of a compile.
///
/// A failed compile is **returned, not thrown**. A rejected promise can only
/// carry a `napi::Error`, which has room for a message and a status and nothing
/// else — diagnostics, positions, and hints would have to be flattened into a
/// string. Returning them keeps the boundary lossless and identical for the
/// sync and async paths, and `@emquad/core` turns a failure into a real `Error`
/// subclass, which is where a JS subclass belongs anyway.
///
/// Argument and usage errors *do* throw: they are programming mistakes, not
/// outcomes.
#[napi(object)]
pub struct CompileResult {
    pub ok: bool,
    /// Zero-copy. Present when `ok`.
    pub pdf: Option<Buffer>,
    /// Present even on success — warnings are the most likely place a
    /// silently-wrong document announces itself.
    pub warnings: Vec<Diagnostic>,
    pub pages: Option<u32>,
    pub error: Option<CompileFailure>,
}

fn position(diagnostic: &emquad_engine::Position) -> Position {
    Position { file: diagnostic.file.clone(), line: diagnostic.line, column: diagnostic.column }
}

pub fn diagnostic(source: &emquad_engine::Diagnostic) -> Diagnostic {
    Diagnostic {
        severity: source.severity.to_string(),
        message: source.message.clone(),
        position: source.position.as_ref().map(position),
        hints: source
            .hints
            .iter()
            .map(|hint| Hint {
                message: hint.message.clone(),
                position: hint.position.as_ref().map(position),
            })
            .collect(),
        trace: source
            .trace
            .iter()
            .map(|frame| TraceFrame {
                message: frame.message.clone(),
                position: frame.position.as_ref().map(position),
            })
            .collect(),
    }
}

pub fn success(output: emquad_engine::CompileOutput) -> CompileResult {
    CompileResult {
        ok: true,
        warnings: output.warnings.iter().map(diagnostic).collect(),
        pages: Some(output.pages as u32),
        // `Buffer::from(Vec<u8>)` hands ownership to V8 without copying. A
        // multi-megabyte PDF is exactly the thing not to copy needlessly.
        pdf: Some(Buffer::from(output.pdf)),
        error: None,
    }
}

pub fn failure(error: &emquad_engine::Error) -> CompileResult {
    CompileResult {
        ok: false,
        pdf: None,
        warnings: Vec::new(),
        pages: None,
        error: Some(CompileFailure {
            code: error.code().to_owned(),
            message: error.to_string(),
            diagnostics: error.diagnostics().iter().map(diagnostic).collect(),
        }),
    }
}

/// A caught panic, reported as a compile failure rather than an abort.
///
/// A Rust panic crossing into Node kills the process. The engine already wraps
/// its compile boundary; this covers everything else on the way there.
pub fn panicked(message: String) -> CompileResult {
    CompileResult {
        ok: false,
        pdf: None,
        warnings: Vec::new(),
        pages: None,
        error: Some(CompileFailure {
            code: "PANIC".to_owned(),
            message: format!("internal panic: {message}"),
            diagnostics: Vec::new(),
        }),
    }
}
