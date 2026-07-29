//! VFS paths and the process-global interning guard.
//!
//! # Why this module exists
//!
//! `typst_syntax::FileId` is a process-global interner. Every distinct
//! `RootedPath` is `Box::leak`'d, entries are never freed, the id is a
//! `NonZeroU16`, and allocation past 65,535 panics:
//!
//! ```text
//! out of file ids: TryFromIntError(PosOverflow)
//! ```
//!
//! A server that names files per request — `invoice-${uuid}.typ` — therefore
//! leaks memory permanently and crashes the process at ~65k renders. The fix is
//! a discipline, not a data structure: **content varies, paths never do**
//! (hard rule 1).
//!
//! [`intern`] is the only place in this crate that constructs a `FileId`. It
//! trips a guard at [`DEFAULT_LIMIT`] and reports the *pattern* of the paths
//! that filled the vocabulary, because "you are out of file ids" is useless
//! without knowing which template generated them.
//!
//! `FileId::unique` (formerly `new_fake`) is never used: it skips
//! deduplication entirely and makes the leak strictly worse.

use std::collections::HashMap;
use std::fmt;
use std::sync::{LazyLock, RwLock};

use typst::syntax::package::PackageSpec;
use typst::syntax::{FileId, RootedPath, VirtualPath, VirtualRoot};

use crate::error::{Error, Result};

/// The guard trips here. Typst's real cap is [`TYPST_CAP`]; the gap leaves room
/// for paths typst interns on its own (relative imports, package sub-files)
/// between our checks.
pub const DEFAULT_LIMIT: u32 = 50_000;

/// The hard cap in typst 0.15.1, measured in Phase 0. Interning path 65,536
/// panics.
pub const TYPST_CAP: u32 = 65_535;

/// A path in the virtual file system, either in the project root or inside a
/// package.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct VfsPath(RootedPath);

impl VfsPath {
    /// A path in the project root. Leading slashes are optional and `.`/`..`
    /// segments are normalized away; the path can never escape the root.
    pub fn project(path: &str) -> Result<Self> {
        Ok(Self(RootedPath::new(VirtualRoot::Project, vpath(path)?)))
    }

    /// A path inside a package, e.g.
    /// `VfsPath::package("@preview/cetz:0.4.2", "lib.typ")`.
    pub fn package(spec: &str, path: &str) -> Result<Self> {
        let parsed: PackageSpec = spec.parse().map_err(|reason| Error::InvalidPackageSpec {
            spec: spec.to_string(),
            reason: format!("{reason}"),
        })?;
        Ok(Self(RootedPath::new(VirtualRoot::Package(parsed), vpath(path)?)))
    }

    /// The path an already-interned [`FileId`] points at.
    ///
    /// Used to render diagnostics in terms of VFS paths rather than opaque ids.
    pub fn of(id: FileId) -> Self {
        Self(id.get().clone())
    }

    pub fn as_rooted(&self) -> &RootedPath {
        &self.0
    }

    /// The path within its root, always with a leading slash.
    pub fn within_root(&self) -> &str {
        self.0.vpath().get_with_slash()
    }

    /// A displayable, round-trippable rendering: `/main.typ` for project files,
    /// `@preview/cetz:0.4.2/lib.typ` for package files.
    pub fn display(&self) -> String {
        match self.0.root() {
            VirtualRoot::Project => self.within_root().to_string(),
            VirtualRoot::Package(spec) => format!("{spec}{}", self.within_root()),
        }
    }

    /// Intern this path, subject to the guard. See [`intern`].
    pub fn intern(&self) -> Result<FileId> {
        intern(self)
    }
}

impl fmt::Debug for VfsPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.display())
    }
}

impl fmt::Display for VfsPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.display())
    }
}

fn vpath(path: &str) -> Result<VirtualPath> {
    VirtualPath::new(path)
        .map_err(|err| Error::InvalidPath { path: path.to_string(), reason: err.to_string() })
}

/// Intern a VFS path, refusing to do so once the vocabulary limit is reached.
///
/// This is the only `FileId` constructor in the crate. Repeat lookups are
/// served under a read lock, which also keeps compiles off typst's own interner
/// write lock — that lock is taken unconditionally by `FileId::new`, even for
/// paths it already knows.
pub fn intern(path: &VfsPath) -> Result<FileId> {
    if let Some(&id) = GUARD.read().unwrap().ids.get(path) {
        return Ok(id);
    }

    let mut guard = GUARD.write().unwrap();

    // Another thread may have interned it between the two locks.
    if let Some(&id) = guard.ids.get(path) {
        return Ok(id);
    }

    if guard.high_water >= guard.limit {
        let (pattern, matching) = guard.dominant_family();
        return Err(Error::PathVocabularyExhausted {
            path: path.display(),
            pattern,
            matching,
            interned: guard.high_water,
            limit: guard.limit,
        });
    }

    let id = FileId::new(path.0.clone());

    // The raw id *is* typst's interner index, so this also catches paths typst
    // interned behind our back while resolving imports: the number jumps by
    // more than one and `high_water` follows it.
    guard.high_water = guard.high_water.max(u32::from(id.into_raw().get()));
    guard.ids.insert(path.clone(), id);
    *guard.families.entry(family(&path.display())).or_insert(0) += 1;

    Ok(id)
}

/// A snapshot of interner pressure, for metrics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathStats {
    /// Distinct paths interned process-wide, including any typst interned
    /// itself. This is the number the guard compares against `limit`.
    pub interned: u32,
    /// Distinct paths interned through [`intern`]. Lower than `interned`
    /// whenever typst resolved an import on its own.
    pub tracked: u32,
    /// The configured limit.
    pub limit: u32,
    /// Typst's hard cap, past which it panics.
    pub cap: u32,
}

pub fn stats() -> PathStats {
    let guard = GUARD.read().unwrap();
    PathStats {
        interned: guard.high_water,
        tracked: guard.ids.len() as u32,
        limit: guard.limit,
        cap: TYPST_CAP,
    }
}

/// Override the guard limit.
///
/// Raising it past [`TYPST_CAP`] is refused — beyond that point the guard could
/// not fire before typst's own panic, which is the entire reason it exists.
pub fn set_limit(limit: u32) -> u32 {
    let mut guard = GUARD.write().unwrap();
    guard.limit = limit.min(TYPST_CAP);
    guard.limit
}

static GUARD: LazyLock<RwLock<Guard>> = LazyLock::new(|| {
    RwLock::new(Guard {
        ids: HashMap::new(),
        families: HashMap::new(),
        high_water: 0,
        limit: DEFAULT_LIMIT,
    })
});

struct Guard {
    ids: HashMap<VfsPath, FileId>,
    families: HashMap<String, u32>,
    high_water: u32,
    limit: u32,
}

impl Guard {
    fn dominant_family(&self) -> (String, u32) {
        self.families
            .iter()
            .max_by_key(|&(pattern, count)| (count, std::cmp::Reverse(pattern)))
            .map(|(pattern, &count)| (pattern.clone(), count))
            .unwrap_or_else(|| ("<unknown>".to_string(), 0))
    }
}

/// Collapse a path into the family it belongs to, so the guard can name the
/// template that filled the vocabulary rather than one arbitrary victim.
///
/// Any run of three or more alphanumerics containing at least one digit becomes
/// `*`. That folds counters, timestamps, and UUID segments together:
///
/// ```text
/// /invoice-550e8400-e29b-41d4-a716-446655440000.typ  ->  /invoice-*-*-*-*-*.typ
/// /run/2026/07/report-8831.typ                       ->  /run/*/07/report-*.typ
/// /templates/base.typ                                ->  /templates/base.typ
/// ```
///
/// It over-groups slightly — `page1.typ` and `page2.typ` collapse together even
/// when both are legitimately stable. That bias is deliberate: the function is
/// only ever consulted at 50,000 distinct paths, where whatever dominates *is*
/// the problem.
fn family(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut run = String::new();

    let flush = |run: &mut String, out: &mut String| {
        if run.len() >= 3 && run.chars().any(|c| c.is_ascii_digit()) {
            out.push('*');
        } else {
            out.push_str(run);
        }
        run.clear();
    };

    for c in path.chars() {
        if c.is_ascii_alphanumeric() {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_paths_normalize() {
        assert_eq!(VfsPath::project("main.typ").unwrap().display(), "/main.typ");
        assert_eq!(VfsPath::project("/main.typ").unwrap().display(), "/main.typ");
        assert_eq!(VfsPath::project("a/../b/./c.typ").unwrap().display(), "/b/c.typ");
    }

    #[test]
    fn paths_cannot_escape_the_root() {
        let err = VfsPath::project("../secrets.typ").unwrap_err();
        assert!(matches!(err, Error::InvalidPath { .. }), "{err}");
    }

    #[test]
    fn package_paths_render_with_their_spec() {
        let path = VfsPath::package("@preview/cetz:0.4.2", "lib.typ").unwrap();
        assert_eq!(path.display(), "@preview/cetz:0.4.2/lib.typ");
    }

    #[test]
    fn bad_package_spec_is_an_error() {
        let err = VfsPath::package("cetz", "lib.typ").unwrap_err();
        assert!(matches!(err, Error::InvalidPackageSpec { .. }), "{err}");
    }

    #[test]
    fn interning_is_stable_and_deduplicated() {
        let a = VfsPath::project("/stable.typ").unwrap().intern().unwrap();
        let b = VfsPath::project("stable.typ").unwrap().intern().unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn family_collapses_variable_runs() {
        assert_eq!(
            family("/invoice-550e8400-e29b-41d4-a716-446655440000.typ"),
            "/invoice-*-*-*-*-*.typ"
        );
        assert_eq!(family("/run/2026/07/report-8831.typ"), "/run/*/07/report-*.typ");
        assert_eq!(family("/templates/base.typ"), "/templates/base.typ");
        // Two characters is not enough signal to call something variable.
        assert_eq!(family("/h1.typ"), "/h1.typ");
    }

    #[test]
    fn path_id_round_trips_to_its_path() {
        let path = VfsPath::project("/round/trip.typ").unwrap();
        let id = path.intern().unwrap();
        assert_eq!(VfsPath::of(id), path);
        assert_eq!(VfsPath::of(id).display(), "/round/trip.typ");
    }
}
