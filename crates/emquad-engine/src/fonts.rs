//! The font registry.
//!
//! Fonts are parsed once and shared. `Font` is `Arc`-backed, so handing a
//! clone to each compile is a refcount bump — never a re-parse. Rebuilding the
//! `FontBook` per compile would invalidate the `comemo` memo cache and destroy
//! throughput (hard rule 6), which is why [`FontRegistry::extended_with`]
//! returns a *new* registry rather than mutating in place: the cost is visible
//! in the signature.
//!
//! # An empty registry is rejected
//!
//! Phase 0 measured this: with no fonts registered, typst compiles
//! *successfully* and emits a valid PDF in which every text run — body text
//! included, not just SVG — is silently dropped, with zero diagnostics. A blank
//! page is the worst possible way for a font problem to reach a user, so
//! [`FontRegistryBuilder::build`] refuses (hard rule 8).

use std::sync::Arc;

use typst::foundations::Bytes;
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;

use crate::error::{Error, Result};

#[derive(Debug, Default, Clone)]
pub struct FontRegistryBuilder {
    fonts: Vec<Font>,
}

impl FontRegistryBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parse a font file and register every face in it.
    ///
    /// Returns the number of faces added; a TrueType collection yields several,
    /// and unparsable data yields zero rather than an error, since a caller
    /// feeding a directory of files usually wants to know the count rather than
    /// abort on the first `.DS_Store`.
    pub fn add(&mut self, data: impl AsRef<[u8]> + Send + Sync + 'static) -> usize {
        let before = self.fonts.len();
        self.fonts.extend(Font::iter(Bytes::new(data)));
        self.fonts.len() - before
    }

    pub fn len(&self) -> usize {
        self.fonts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.fonts.is_empty()
    }

    /// Build the registry, or fail with [`Error::NoFonts`] if nothing parsed.
    pub fn build(self) -> Result<FontRegistry> {
        FontRegistry::from_faces(self.fonts)
    }
}

/// A parsed, shareable set of fonts and the `FontBook` describing them.
#[derive(Debug, Clone)]
pub struct FontRegistry {
    book: Arc<LazyHash<FontBook>>,
    fonts: Arc<Vec<Font>>,
}

impl FontRegistry {
    pub fn builder() -> FontRegistryBuilder {
        FontRegistryBuilder::new()
    }

    fn from_faces(fonts: Vec<Font>) -> Result<Self> {
        if fonts.is_empty() {
            return Err(Error::NoFonts);
        }
        let mut book = FontBook::new();
        for font in &fonts {
            book.push(font.info().clone());
        }
        Ok(Self { book: Arc::new(LazyHash::new(book)), fonts: Arc::new(fonts) })
    }

    /// Register additional fonts, returning a **new** registry.
    ///
    /// The `FontBook` is rebuilt, so compiles using the returned registry start
    /// from a cold `comemo` cache. Reuse of the original registry is unaffected.
    pub fn extended_with(
        &self,
        data: impl AsRef<[u8]> + Send + Sync + 'static,
    ) -> Result<Self> {
        let mut fonts = (*self.fonts).clone();
        fonts.extend(Font::iter(Bytes::new(data)));
        Self::from_faces(fonts)
    }

    /// The number of registered faces.
    pub fn len(&self) -> usize {
        self.fonts.len()
    }

    /// Always false — an empty registry cannot be constructed. Present because
    /// clippy asks for it alongside `len`.
    pub fn is_empty(&self) -> bool {
        false
    }

    /// Registered family names, deduplicated and sorted.
    ///
    /// Names come from the font's Name ID 1 with styling suffixes trimmed, so
    /// `Inter-Variable.ttf` reports the family `Inter`: typst strips `variable`,
    /// `var`, and `vf` along with weight and width suffixes, case-insensitively.
    /// Case in the returned names is otherwise preserved, and matching in Typst
    /// markup is case-insensitive.
    pub fn families(&self) -> Vec<String> {
        let mut names: Vec<String> =
            self.fonts.iter().map(|f| f.info().family.clone()).collect();
        names.sort_unstable();
        names.dedup();
        names
    }

    pub(crate) fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    /// Look up a face by index.
    ///
    /// Out-of-bounds indices are expected, not exceptional: typst documents
    /// that `World::font` may be called with indices from an outdated or
    /// different font book during incremental compilation validation. Returns
    /// `None`; never panics.
    pub(crate) fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn typst_fonts() -> FontRegistry {
        let mut builder = FontRegistryBuilder::new();
        for data in typst_assets::fonts() {
            builder.add(data);
        }
        builder.build().unwrap()
    }

    #[test]
    fn an_empty_registry_is_rejected() {
        // Hard rule 8. Typst would happily compile a blank PDF with no warning.
        assert_eq!(FontRegistryBuilder::new().build().unwrap_err(), Error::NoFonts);
    }

    #[test]
    fn unparsable_data_adds_no_faces_and_still_fails_closed() {
        let mut builder = FontRegistryBuilder::new();
        assert_eq!(builder.add(b"not a font at all".to_vec()), 0);
        assert_eq!(builder.build().unwrap_err(), Error::NoFonts);
    }

    #[test]
    fn faces_parse_and_report_families() {
        let registry = typst_fonts();
        assert!(registry.len() > 1);
        let families = registry.families();
        assert!(
            families.contains(&"New Computer Modern".to_owned()),
            "expected typst's default family, got {families:?}"
        );
        assert!(families.windows(2).all(|w| w[0] < w[1]), "families must be sorted");
        // Styling suffixes are trimmed, so the four faces of a family collapse
        // to one name rather than appearing as "… Bold", "… Italic", and so on.
        assert!(
            families.iter().all(|f| !f.to_ascii_lowercase().ends_with("bold")),
            "styling suffixes leaked into family names: {families:?}"
        );
    }

    #[test]
    fn out_of_bounds_indices_return_none() {
        let registry = typst_fonts();
        assert!(registry.font(registry.len()).is_none());
        assert!(registry.font(usize::MAX).is_none());
        assert!(registry.font(0).is_some());
    }

    #[test]
    fn extending_produces_a_new_registry_and_leaves_the_original_alone() {
        let original = typst_fonts();
        let before = original.len();
        let extra = typst_assets::fonts().next().expect("typst-assets ships fonts");
        let extended = original.extended_with(extra).unwrap();

        assert!(extended.len() > before);
        assert_eq!(original.len(), before);
    }

    #[test]
    fn cloning_shares_the_font_book() {
        let registry = typst_fonts();
        let clone = registry.clone();
        assert!(Arc::ptr_eq(&registry.book, &clone.book));
    }
}
