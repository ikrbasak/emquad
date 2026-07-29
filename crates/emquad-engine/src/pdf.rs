//! PDF export settings.
//!
//! A thin, owned mirror of `typst_pdf::PdfOptions`. Owned because these values
//! cross an FFI boundary in Phase 2, and validated up front because
//! `PdfStandards::new` is where mutually incompatible standards are caught.

use std::num::NonZeroUsize;

use typst::foundations::Smart;
use typst::layout::{PageRange as TypstPageRange, PageRanges};

pub use typst_pdf::PdfStandard;

use crate::clock::Clock;
use crate::error::{Error, Result};

/// An inclusive, 1-based range of pages to export. Both ends are optional:
/// `PageRange { start: Some(3), end: None }` means "page 3 to the end".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PageRange {
    pub start: Option<usize>,
    pub end: Option<usize>,
}

impl PageRange {
    pub fn from(start: usize) -> Self {
        Self { start: Some(start), end: None }
    }

    pub fn to(end: usize) -> Self {
        Self { start: None, end: Some(end) }
    }

    pub fn between(start: usize, end: usize) -> Self {
        Self { start: Some(start), end: Some(end) }
    }

    fn convert(self) -> Result<TypstPageRange> {
        let bound = |value: Option<usize>| -> Result<Option<NonZeroUsize>> {
            match value {
                None => Ok(None),
                Some(n) => {
                    NonZeroUsize::new(n).map(Some).ok_or_else(|| Error::InvalidPdfSettings {
                        message: "page numbers are 1-based; 0 is not a page".to_owned(),
                        hints: vec!["use 1 for the first page".to_owned()],
                    })
                }
            }
        };
        Ok(bound(self.start)?..=bound(self.end)?)
    }
}

/// What to write into the PDF's `/Creator` field.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub enum Creator {
    /// `Typst <version>`, upstream's default.
    #[default]
    Auto,
    /// Omit the field entirely.
    Omit,
    Custom(String),
}

/// What to write as the document's creation timestamp.
///
/// Only consulted when the document leaves `set document(date: ..)` at `auto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum PdfTimestamp {
    /// Take it from the compile's [`Clock`]. Default.
    #[default]
    FromClock,
    /// Omit it. Combined with a pinned `ident`, this is what makes output
    /// byte-identical across runs.
    Omit,
    /// A fixed instant, in UTC.
    Fixed { unix_seconds: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfSettings {
    /// Emit a tagged (accessible) PDF.
    ///
    /// Upstream defaults to `true` and so do we. Phase 0 measured the cost as
    /// +5–28% compile time but **up to +302% output size** — the size, not the
    /// time, is what to weigh. Do not turn this off to make a benchmark look
    /// better: it is an accessibility regression users would not notice.
    pub tagged: bool,

    /// Format the PDF readably. Larger output; useful when diffing.
    pub pretty: bool,

    /// Standards to enforce (PDF/A, PDF/UA, a specific PDF version).
    /// Incompatible combinations are rejected before the compile starts.
    pub standards: Vec<PdfStandard>,

    /// Which pages to export. `None` exports all of them.
    ///
    /// Requires `tagged: false` — an accessibility structure tree describes the
    /// whole document and cannot describe a subset of it.
    pub page_ranges: Option<Vec<PageRange>>,

    /// A stable identifier for the document.
    ///
    /// `None` lets typst hash the title and author instead. Only set this if it
    /// really is stable across compiles of the same document — an unstable
    /// value is worse than none.
    pub ident: Option<String>,

    pub creator: Creator,

    pub timestamp: PdfTimestamp,
}

impl Default for PdfSettings {
    fn default() -> Self {
        Self {
            tagged: true,
            pretty: false,
            standards: Vec::new(),
            page_ranges: None,
            ident: None,
            creator: Creator::Auto,
            timestamp: PdfTimestamp::FromClock,
        }
    }
}

impl PdfSettings {
    /// Settings that produce byte-identical output across runs.
    ///
    /// Pins `ident` and drops the timestamp. The third input to reproducibility
    /// is the clock, which lives on the compile rather than here — use
    /// [`crate::Compile::reproducible`] to set all three at once.
    pub fn reproducible(ident: impl Into<String>) -> Self {
        Self { ident: Some(ident.into()), timestamp: PdfTimestamp::Omit, ..Self::default() }
    }

    pub(crate) fn to_options(&self, clock: Clock) -> Result<typst_pdf::PdfOptions> {
        let standards = typst_pdf::PdfStandards::new(&self.standards).map_err(|err| {
            Error::InvalidPdfSettings {
                message: err.message().to_string(),
                hints: err.hints().iter().map(|hint| hint.to_string()).collect(),
            }
        })?;

        let page_ranges = match &self.page_ranges {
            None => None,
            Some(ranges) => {
                // Typst refuses this combination, but only at export — after a
                // full compile has already been paid for. Catching it here
                // turns a late, position-less error into an argument error.
                if self.tagged {
                    return Err(Error::InvalidPdfSettings {
                        message: "a tagged PDF cannot be restricted to a page range".to_owned(),
                        hints: vec![
                            "set `tagged: false` to export a page range".to_owned(),
                            "the accessibility structure tree spans the whole \
                             document, so it cannot describe a subset of it"
                                .to_owned(),
                        ],
                    });
                }
                Some(PageRanges::new(
                    ranges.iter().map(|range| range.convert()).collect::<Result<Vec<_>>>()?,
                ))
            }
        };

        let timestamp = match self.timestamp {
            PdfTimestamp::Omit => None,
            PdfTimestamp::FromClock => clock.pdf_timestamp(),
            PdfTimestamp::Fixed { unix_seconds } => Clock::fixed(unix_seconds).pdf_timestamp(),
        };

        Ok(typst_pdf::PdfOptions {
            ident: match &self.ident {
                None => Smart::Auto,
                Some(ident) => Smart::Custom(ident.clone()),
            },
            creator: match &self.creator {
                Creator::Auto => Smart::Auto,
                Creator::Omit => Smart::Custom(None),
                Creator::Custom(creator) => Smart::Custom(Some(creator.clone())),
            },
            timestamp,
            page_ranges,
            standards,
            tagged: self.tagged,
            pretty: self.pretty,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_keep_tagged_output() {
        // Upstream's default, kept deliberately. See the field docs.
        assert!(PdfSettings::default().tagged);
    }

    #[test]
    fn incompatible_standards_are_rejected_with_hints() {
        let settings = PdfSettings {
            standards: vec![PdfStandard::A_1b, PdfStandard::A_2b],
            ..Default::default()
        };
        let err = settings.to_options(Clock::Unavailable).unwrap_err();
        assert!(matches!(err, Error::InvalidPdfSettings { .. }), "{err}");
    }

    #[test]
    fn a_page_range_on_a_tagged_pdf_is_rejected_before_compiling() {
        // Typst catches this at export, after a whole compile has been paid
        // for, and reports it without a position or a hint.
        let settings = PdfSettings {
            page_ranges: Some(vec![PageRange::between(1, 2)]),
            ..Default::default()
        };
        match settings.to_options(Clock::Unavailable).unwrap_err() {
            Error::InvalidPdfSettings { hints, .. } => {
                assert!(hints.iter().any(|hint| hint.contains("tagged: false")), "{hints:?}");
            }
            other => panic!("expected InvalidPdfSettings, got {other}"),
        }
    }

    #[test]
    fn page_zero_is_rejected() {
        let settings = PdfSettings {
            tagged: false,
            page_ranges: Some(vec![PageRange::between(0, 3)]),
            ..Default::default()
        };
        let err = settings.to_options(Clock::Unavailable).unwrap_err();
        assert!(matches!(err, Error::InvalidPdfSettings { .. }), "{err}");
    }

    #[test]
    fn open_ended_ranges_convert() {
        let settings = PdfSettings {
            tagged: false,
            page_ranges: Some(vec![PageRange::from(2), PageRange::to(1)]),
            ..Default::default()
        };
        let options = settings.to_options(Clock::Unavailable).unwrap();
        let ranges = options.page_ranges.expect("ranges were set");
        assert!(ranges.includes_page(NonZeroUsize::new(1).unwrap()));
        assert!(ranges.includes_page(NonZeroUsize::new(2).unwrap()));
        assert!(ranges.includes_page(NonZeroUsize::new(9).unwrap()));
    }

    #[test]
    fn the_reproducible_preset_drops_the_timestamp() {
        let settings = PdfSettings::reproducible("invoice-template-v1");
        let options = settings.to_options(Clock::utc()).unwrap();
        assert!(options.timestamp.is_none());
        assert!(matches!(options.ident, Smart::Custom(_)));
    }
}
