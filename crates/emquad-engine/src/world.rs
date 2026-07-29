//! The `World` implementation.
//!
//! Seven methods, deliberately kept in one small module: this is the entire
//! blast radius of a typst upgrade. When `=0.15.1` moves, this file and
//! [`crate::paths`] are what break.

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, Source};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, World};

use crate::clock::Clock;
use crate::fonts::FontRegistry;
use crate::vfs::{Overlay, Workspace, resolve};

pub(crate) struct EmquadWorld<'a> {
    pub(crate) library: &'a LazyHash<Library>,
    pub(crate) fonts: &'a FontRegistry,
    pub(crate) base: &'a Workspace,
    pub(crate) overlay: &'a Overlay,
    pub(crate) main: FileId,
    pub(crate) clock: Clock,
}

impl World for EmquadWorld<'_> {
    fn library(&self) -> &LazyHash<Library> {
        self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        // Decoded from the same byte store as `file`, so the two can never
        // disagree about what a path contains.
        let bytes = self.file(id)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| FileError::InvalidUtf8)?;
        Ok(Source::new(id, text.to_owned()))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        resolve(self.overlay, self.base, id)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.clock.today(offset)
    }
}
