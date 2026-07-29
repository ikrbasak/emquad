//! The layered virtual file system.
//!
//! Two layers, with different lifetimes and different costs:
//!
//! - [`Workspace`] — long-lived and shared. Templates, logos, fonts' companion
//!   assets, mounted `@preview` packages. Behind an `Arc`, so cloning it per
//!   compile is a refcount bump and concurrent compiles cannot tear it.
//! - [`Overlay`] — one per compile, small. `main.typ` and this request's data.
//!
//! Resolution is overlay → base → `NotFound`.
//!
//! Keeping the base stable is not merely an optimization. `comemo` memoizes on
//! the `World`, so rebuilding the base layer between compiles invalidates the
//! memo cache and destroys throughput (hard rule 6).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use typst::diag::{FileError, FileResult};
use typst::foundations::Bytes;
use typst::syntax::FileId;

use crate::error::Result;
use crate::paths::VfsPath;

/// Builds the shared base layer. Interning happens here, once, rather than on
/// the hot path.
#[derive(Debug, Default, Clone)]
pub struct WorkspaceBuilder {
    files: HashMap<FileId, Bytes>,
}

impl WorkspaceBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a binary file — an image, a font companion asset, a data blob.
    pub fn file(
        &mut self,
        path: &VfsPath,
        data: impl AsRef<[u8]> + Send + Sync + 'static,
    ) -> Result<&mut Self> {
        self.files.insert(path.intern()?, Bytes::new(data));
        Ok(self)
    }

    /// Add a text file. Convenience over [`WorkspaceBuilder::file`] for the
    /// common case of a borrowed `&str`, which it copies.
    pub fn source(&mut self, path: &VfsPath, text: &str) -> Result<&mut Self> {
        self.file(path, text.to_owned())
    }

    pub fn build(self) -> Workspace {
        Workspace { files: Arc::new(self.files) }
    }
}

/// The shared, immutable base layer.
#[derive(Debug, Default, Clone)]
pub struct Workspace {
    files: Arc<HashMap<FileId, Bytes>>,
}

impl Workspace {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn contains(&self, id: FileId) -> bool {
        self.files.contains_key(&id)
    }

    pub(crate) fn get(&self, id: FileId) -> Option<&Bytes> {
        self.files.get(&id)
    }
}

/// The per-compile layer. Shadows the base; never mutates it.
#[derive(Debug, Default, Clone)]
pub struct Overlay {
    files: HashMap<FileId, Bytes>,
}

impl Overlay {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn file(
        &mut self,
        path: &VfsPath,
        data: impl AsRef<[u8]> + Send + Sync + 'static,
    ) -> Result<&mut Self> {
        self.files.insert(path.intern()?, Bytes::new(data));
        Ok(self)
    }

    pub fn source(&mut self, path: &VfsPath, text: &str) -> Result<&mut Self> {
        self.file(path, text.to_owned())
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn contains(&self, id: FileId) -> bool {
        self.files.contains_key(&id)
    }

    pub(crate) fn get(&self, id: FileId) -> Option<&Bytes> {
        self.files.get(&id)
    }
}

/// Overlay wins, then base, then `NotFound`.
pub(crate) fn resolve(overlay: &Overlay, base: &Workspace, id: FileId) -> FileResult<Bytes> {
    overlay
        .get(id)
        .or_else(|| base.get(id))
        .cloned()
        .ok_or_else(|| FileError::NotFound(PathBuf::from(VfsPath::of(id).display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(path: &str) -> VfsPath {
        VfsPath::project(path).unwrap()
    }

    #[test]
    fn overlay_shadows_base() {
        let mut builder = WorkspaceBuilder::new();
        builder.source(&p("/vfs/shadowed.typ"), "base").unwrap();
        let base = builder.build();

        let mut overlay = Overlay::new();
        overlay.source(&p("/vfs/shadowed.typ"), "overlay").unwrap();

        let id = p("/vfs/shadowed.typ").intern().unwrap();
        assert_eq!(resolve(&overlay, &base, id).unwrap().as_slice(), b"overlay");
    }

    #[test]
    fn base_survives_the_overlay() {
        let mut builder = WorkspaceBuilder::new();
        builder.source(&p("/vfs/kept.typ"), "base").unwrap();
        let base = builder.build();

        let mut overlay = Overlay::new();
        overlay.source(&p("/vfs/kept.typ"), "overlay").unwrap();
        let id = p("/vfs/kept.typ").intern().unwrap();
        let _ = resolve(&overlay, &base, id);

        // The base layer is shared across concurrent compiles; an overlay write
        // that reached it would corrupt every other in-flight compile.
        assert_eq!(base.get(id).unwrap().as_slice(), b"base");
    }

    #[test]
    fn base_resolves_when_the_overlay_is_silent() {
        let mut builder = WorkspaceBuilder::new();
        builder.source(&p("/vfs/base-only.typ"), "base").unwrap();
        let base = builder.build();

        let id = p("/vfs/base-only.typ").intern().unwrap();
        assert_eq!(resolve(&Overlay::new(), &base, id).unwrap().as_slice(), b"base");
    }

    #[test]
    fn a_missing_file_is_not_found_rather_than_a_panic() {
        let id = p("/vfs/absent.typ").intern().unwrap();
        let err = resolve(&Overlay::new(), &Workspace::empty(), id).unwrap_err();
        match err {
            // The path, not the FileId, so the message is diagnosable.
            FileError::NotFound(path) => assert_eq!(path.to_str(), Some("/vfs/absent.typ")),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn cloning_the_workspace_shares_rather_than_copies() {
        let mut builder = WorkspaceBuilder::new();
        builder.source(&p("/vfs/shared.typ"), "base").unwrap();
        let base = builder.build();
        let clone = base.clone();

        let id = p("/vfs/shared.typ").intern().unwrap();
        assert!(std::ptr::eq(base.get(id).unwrap(), clone.get(id).unwrap()));
    }
}
