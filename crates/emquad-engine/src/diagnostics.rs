//! Structured diagnostics.
//!
//! This is the main differentiator over the existing binding, so it is
//! deliberately over-invested in:
//!
//! - **Positions are resolved**, not left as opaque spans. `file`, `line`, and
//!   `column` are what a caller needs to point an editor at the problem.
//! - **Hints are preserved.** Typst's hints are genuinely good and are usually
//!   the actionable half of the message; discarding them is a real loss.
//! - **Warnings survive success.** `typst::compile` returns `Warned<T>`, so a
//!   successful compile still carries them.
//! - **Traces are kept**, which is the only way to locate an error that
//!   occurred inside an imported file or a `@preview` package.
//!
//! Line and column are **1-based** here; typst's `Lines` API is 0-based, and
//! the conversion happens in exactly one place (`locate`).

use std::fmt;

use typst::World;
use typst::diag::{Severity as TypstSeverity, SourceDiagnostic};
use typst::syntax::DiagSpan;

use crate::paths::VfsPath;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Severity {
    Error,
    Warning,
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        })
    }
}

/// A resolved position in the VFS. All three fields travel together — a line
/// without a file is not useful — which is why they are one struct rather than
/// three parallel `Option`s.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Position {
    /// The VFS path, e.g. `/main.typ` or `@preview/cetz:0.4.2/lib.typ`.
    pub file: String,
    /// 1-based.
    pub line: u32,
    /// 1-based, counted in characters.
    pub column: u32,
}

impl fmt::Display for Position {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}:{}", self.file, self.line, self.column)
    }
}

/// A hint attached to a diagnostic. Typst 0.15 lets a hint carry its own
/// position, pointing at a *different* piece of code than the error itself.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Hint {
    pub message: String,
    pub position: Option<Position>,
}

/// One frame of the call chain leading to a diagnostic.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TraceFrame {
    /// Already rendered, e.g. `while calling \`invoice\`` or
    /// `while importing \`cetz\``.
    pub message: String,
    pub position: Option<Position>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Diagnostic {
    pub severity: Severity,
    pub message: String,
    /// `None` when the diagnostic is detached — it does not point into any
    /// file. Configuration errors and some export failures are like this.
    pub position: Option<Position>,
    pub hints: Vec<Hint>,
    pub trace: Vec<TraceFrame>,
}

impl Diagnostic {
    /// Convenience accessors so callers do not have to unwrap `position`.
    pub fn file(&self) -> Option<&str> {
        self.position.as_ref().map(|p| p.file.as_str())
    }

    pub fn line(&self) -> Option<u32> {
        self.position.as_ref().map(|p| p.line)
    }

    pub fn column(&self) -> Option<u32> {
        self.position.as_ref().map(|p| p.column)
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.severity)?;
        if let Some(position) = &self.position {
            write!(f, " at {position}")?;
        }
        write!(f, ": {}", self.message)?;
        for hint in &self.hints {
            write!(f, "\n  hint: {}", hint.message)?;
        }
        for frame in &self.trace {
            write!(f, "\n  {}", frame.message)?;
            if let Some(position) = &frame.position {
                write!(f, " at {position}")?;
            }
        }
        Ok(())
    }
}

/// Convert typst's diagnostics into ours, resolving every span against the
/// world that produced them.
pub(crate) fn convert(
    world: &dyn World,
    diagnostics: impl IntoIterator<Item = SourceDiagnostic>,
) -> Vec<Diagnostic> {
    diagnostics
        .into_iter()
        .map(|diagnostic| Diagnostic {
            severity: match diagnostic.severity {
                TypstSeverity::Error => Severity::Error,
                TypstSeverity::Warning => Severity::Warning,
            },
            message: diagnostic.message.to_string(),
            position: locate(world, diagnostic.span),
            hints: diagnostic
                .hints
                .into_iter()
                .map(|hint| Hint {
                    message: hint.v.to_string(),
                    position: locate(world, hint.span),
                })
                .collect(),
            trace: diagnostic
                .trace
                .into_iter()
                .map(|frame| TraceFrame {
                    message: frame.v.to_string(),
                    position: locate(world, frame.span.into()),
                })
                .collect(),
        })
        .collect()
}

/// Resolve a span to a file, line, and column.
///
/// The only place 0-based typst offsets become 1-based positions.
fn locate(world: &dyn World, span: DiagSpan) -> Option<Position> {
    use typst::WorldExt;

    let id = span.id()?;
    let range = world.range(span)?;
    let source = world.source(id).ok()?;
    let (line, column) = source.lines().byte_to_line_column(range.start)?;

    Some(Position {
        file: VfsPath::of(id).display(),
        line: line as u32 + 1,
        column: column as u32 + 1,
    })
}
