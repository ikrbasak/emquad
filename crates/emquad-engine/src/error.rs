//! Structured errors.
//!
//! Every variant carries the fields a caller needs to act on, not a
//! pre-formatted string. The napi layer maps these onto JS error properties;
//! `Display` exists for logs and `cargo test` output, not for parsing.

use std::fmt;

use crate::diagnostics::Diagnostic;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Typst reported fatal errors while compiling.
    Compile { diagnostics: Vec<Diagnostic> },

    /// The document compiled but PDF export failed. Almost always a standards
    /// conformance problem (PDF/A or PDF/UA), which is why it is distinct from
    /// [`Error::Compile`].
    Export { diagnostics: Vec<Diagnostic> },

    /// No fonts were registered.
    ///
    /// Typst does *not* treat this as an error: it compiles successfully and
    /// emits a valid PDF with every text run silently dropped and zero
    /// diagnostics. Rejecting it here is hard rule 8.
    NoFonts,

    /// The path vocabulary guard tripped.
    ///
    /// `FileId` is a process-global interner that leaks every entry and panics
    /// at exactly 65,535. This error fires well before that so the caller sees
    /// a diagnosable failure instead of a dead process.
    PathVocabularyExhausted {
        /// The path that would have been interned.
        path: String,
        /// The dominant path family, with variable-looking runs replaced by
        /// `*` — usually the culprit, e.g. `/invoice-*-*-*-*-*.typ`.
        pattern: String,
        /// How many distinct interned paths match `pattern`.
        matching: u32,
        /// Total distinct paths interned process-wide.
        interned: u32,
        /// The configured limit.
        limit: u32,
    },

    /// A path could not be turned into a virtual path.
    InvalidPath { path: String, reason: String },

    /// A package specification could not be parsed.
    InvalidPackageSpec { spec: String, reason: String },

    /// The main file is not present in either VFS layer.
    MainNotFound { path: String },

    /// PDF export options are mutually incompatible.
    InvalidPdfSettings { message: String, hints: Vec<String> },

    /// A Rust panic was caught at the compile boundary.
    ///
    /// This is always a bug — either ours or upstream's — but it must surface
    /// as an error rather than unwinding into the host process (hard rule 2).
    Panic { message: String },
}

impl Error {
    /// The diagnostics attached to this error, if any.
    pub fn diagnostics(&self) -> &[Diagnostic] {
        match self {
            Error::Compile { diagnostics } | Error::Export { diagnostics } => diagnostics,
            _ => &[],
        }
    }

    /// A stable machine-readable code. The napi layer exposes this as
    /// `error.code` so JS callers can branch without matching on messages.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Compile { .. } => "COMPILE_FAILED",
            Error::Export { .. } => "EXPORT_FAILED",
            Error::NoFonts => "NO_FONTS",
            Error::PathVocabularyExhausted { .. } => "PATH_VOCABULARY_EXHAUSTED",
            Error::InvalidPath { .. } => "INVALID_PATH",
            Error::InvalidPackageSpec { .. } => "INVALID_PACKAGE_SPEC",
            Error::MainNotFound { .. } => "MAIN_NOT_FOUND",
            Error::InvalidPdfSettings { .. } => "INVALID_PDF_SETTINGS",
            Error::Panic { .. } => "PANIC",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Compile { diagnostics } => {
                write!(f, "compilation failed with {} error(s)", diagnostics.len())?;
                if let Some(first) = diagnostics.first() {
                    write!(f, ": {first}")?;
                }
                Ok(())
            }
            Error::Export { diagnostics } => {
                write!(f, "PDF export failed with {} error(s)", diagnostics.len())?;
                if let Some(first) = diagnostics.first() {
                    write!(f, ": {first}")?;
                }
                Ok(())
            }
            Error::NoFonts => f.write_str(
                "no fonts registered; typst would emit a valid PDF with all text \
                 silently dropped. Register at least one font, or install @emquad/fonts",
            ),
            Error::PathVocabularyExhausted { path, pattern, matching, interned, limit } => {
                write!(
                    f,
                    "path vocabulary exhausted: {interned} of {limit} distinct VFS paths \
                 interned, and `{path}` would add another. {matching} interned paths \
                 match `{pattern}` — are you generating a unique filename per render? \
                 VFS paths are interned process-wide and never freed; override by \
                 content at a stable path instead"
                )
            }
            Error::InvalidPath { path, reason } => {
                write!(f, "invalid VFS path `{path}`: {reason}")
            }
            Error::InvalidPackageSpec { spec, reason } => {
                write!(f, "invalid package specification `{spec}`: {reason}")
            }
            Error::MainNotFound { path } => {
                write!(f, "main file `{path}` is not present in the VFS")
            }
            Error::InvalidPdfSettings { message, hints } => {
                write!(f, "invalid PDF settings: {message}")?;
                for hint in hints {
                    write!(f, "\n  hint: {hint}")?;
                }
                Ok(())
            }
            Error::Panic { message } => write!(f, "internal panic: {message}"),
        }
    }
}

impl std::error::Error for Error {}
