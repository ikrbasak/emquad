//! The compiler and the compile entry point.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use typst::utils::LazyHash;
use typst::{Library, LibraryExt};
use typst_layout::PagedDocument;

use crate::clock::Clock;
use crate::diagnostics::Diagnostic;
use crate::error::{Error, Result};
use crate::fonts::{FontRegistry, FontRegistryBuilder};
use crate::paths::VfsPath;
use crate::pdf::PdfSettings;
use crate::vfs::{Overlay, Workspace, WorkspaceBuilder};
use crate::world::EmquadWorld;

/// The default main file. Overridable, but there is rarely a reason to.
pub const DEFAULT_MAIN: &str = "/main.typ";

/// A long-lived compiler.
///
/// Everything expensive lives here and is built exactly once: the standard
/// library, the parsed fonts, and the base VFS layer. Rebuilding any of them
/// per compile invalidates the `comemo` memo cache and destroys throughput
/// (hard rule 6), so `Compiler` is cheap to clone and meant to be shared.
#[derive(Debug, Clone)]
pub struct Compiler {
    library: Arc<LazyHash<Library>>,
    fonts: FontRegistry,
    workspace: Workspace,
    pin_rayon: bool,
}

impl Compiler {
    pub fn builder() -> CompilerBuilder {
        CompilerBuilder::new()
    }

    pub fn fonts(&self) -> &FontRegistry {
        &self.fonts
    }

    pub fn workspace(&self) -> &Workspace {
        &self.workspace
    }

    /// Swap in a different font registry, returning a **new** compiler.
    ///
    /// Compiles through the returned handle start from a cold memo cache,
    /// because the `FontBook` they hash against has changed. The original
    /// compiler is untouched and stays warm.
    pub fn with_fonts(&self, fonts: FontRegistry) -> Self {
        Self { fonts, ..self.clone() }
    }

    /// Begin a compile.
    pub fn compile(&self) -> Compile<'_> {
        Compile {
            compiler: self,
            overlay: Overlay::new(),
            main: None,
            clock: Clock::default(),
            settings: PdfSettings::default(),
            deferred: None,
        }
    }
}

#[derive(Debug, Default)]
pub struct CompilerBuilder {
    fonts: FontRegistryBuilder,
    workspace: WorkspaceBuilder,
    pin_rayon: bool,
    deferred: Option<Error>,
}

impl CompilerBuilder {
    pub fn new() -> Self {
        Self { pin_rayon: true, ..Default::default() }
    }

    /// Register a font file. Returns `self` for chaining; unparsable data is
    /// silently skipped, and an entirely empty registry fails at
    /// [`CompilerBuilder::build`].
    pub fn font(mut self, data: impl AsRef<[u8]> + Send + Sync + 'static) -> Self {
        self.fonts.add(data);
        self
    }

    /// Add a text file to the shared base layer.
    pub fn source(mut self, path: &str, text: &str) -> Self {
        self.try_with(|this| {
            let path = VfsPath::project(path)?;
            this.workspace.source(&path, text)?;
            Ok(())
        });
        self
    }

    /// Add a binary file to the shared base layer.
    pub fn file(mut self, path: &str, data: impl AsRef<[u8]> + Send + Sync + 'static) -> Self {
        self.try_with(|this| {
            let path = VfsPath::project(path)?;
            this.workspace.file(&path, data)?;
            Ok(())
        });
        self
    }

    /// Mount a file belonging to a `@preview` package, e.g.
    /// `package_file("@preview/cetz:0.4.2", "lib.typ", bytes)`.
    ///
    /// Mount the package's `typst.toml` too: typst reads it to find the
    /// entrypoint, and an import fails with a file-not-found error without it.
    ///
    /// Fetching packages is the resolver's job, in TypeScript — this crate only
    /// stores what it is handed (hard rule 4).
    pub fn package_file(
        mut self,
        spec: &str,
        path: &str,
        data: impl AsRef<[u8]> + Send + Sync + 'static,
    ) -> Self {
        self.try_with(|this| {
            let path = VfsPath::package(spec, path)?;
            this.workspace.file(&path, data)?;
            Ok(())
        });
        self
    }

    /// Confine typst's internal rayon usage to the calling thread.
    ///
    /// On by default, because unpinned typst under a saturated worker pool
    /// collapsed to 0.46× in Phase 0. The default is not free: measured
    /// single-threaded, pinning costs **12% on documents with many page runs**
    /// and nothing at all on ordinary ones. Turn it off when compiles are
    /// serial and documents re-configure the page often. See [`crate::rayon`]
    /// for the numbers and the method.
    pub fn pin_rayon(mut self, pin: bool) -> Self {
        self.pin_rayon = pin;
        self
    }

    pub fn build(self) -> Result<Compiler> {
        if let Some(error) = self.deferred {
            return Err(error);
        }
        Ok(Compiler {
            library: Arc::new(LazyHash::new(<Library as LibraryExt>::default())),
            // Hard rule 8: an empty font set compiles to a blank PDF with no
            // diagnostics, so it is rejected here rather than discovered by a
            // user staring at an empty page.
            fonts: self.fonts.build()?,
            workspace: self.workspace.build(),
            pin_rayon: self.pin_rayon,
        })
    }

    /// Record the first error and keep going, so the builder stays chainable.
    fn try_with(&mut self, f: impl FnOnce(&mut Self) -> Result<()>) {
        if self.deferred.is_some() {
            return;
        }
        if let Err(error) = f(self) {
            self.deferred = Some(error);
        }
    }
}

/// One compile in progress.
///
/// Errors from the chained methods are held until [`Compile::run`] so the
/// builder reads cleanly; the first one wins.
#[derive(Debug)]
pub struct Compile<'a> {
    compiler: &'a Compiler,
    overlay: Overlay,
    main: Option<VfsPath>,
    clock: Clock,
    settings: PdfSettings,
    deferred: Option<Error>,
}

impl Compile<'_> {
    /// Set the main file's content, writing it to [`DEFAULT_MAIN`].
    ///
    /// This is the normal entry point: the *content* varies per request while
    /// the *path* stays fixed, which is exactly what hard rule 1 requires.
    pub fn main_source(self, text: &str) -> Self {
        self.source(DEFAULT_MAIN, text).main(DEFAULT_MAIN)
    }

    /// Point at an existing file — one already in the base layer, or added by
    /// [`Compile::source`] — as the main file.
    pub fn main(mut self, path: &str) -> Self {
        self.try_with(|this| {
            this.main = Some(VfsPath::project(path)?);
            Ok(())
        });
        self
    }

    /// Add a text file to this compile's overlay. Shadows the base layer.
    pub fn source(mut self, path: &str, text: &str) -> Self {
        self.try_with(|this| {
            let path = VfsPath::project(path)?;
            this.overlay.source(&path, text)?;
            Ok(())
        });
        self
    }

    /// Add a binary file to this compile's overlay.
    pub fn file(mut self, path: &str, data: impl AsRef<[u8]> + Send + Sync + 'static) -> Self {
        self.try_with(|this| {
            let path = VfsPath::project(path)?;
            this.overlay.file(&path, data)?;
            Ok(())
        });
        self
    }

    pub fn clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    pub fn pdf(mut self, settings: PdfSettings) -> Self {
        self.settings = settings;
        self
    }

    /// Pin every input that would otherwise vary between runs: the clock, the
    /// document identifier, and the PDF timestamp.
    ///
    /// Two compiles of the same sources with the same `ident` and `instant`
    /// produce byte-identical PDFs.
    pub fn reproducible(self, ident: impl Into<String>, instant: i64) -> Self {
        self.clock(Clock::fixed(instant)).pdf(PdfSettings::reproducible(ident))
    }

    /// Compile and export.
    ///
    /// Wrapped in `catch_unwind`: a panic crossing this boundary would abort
    /// the host process (hard rule 2). Note the deliberate absence of a
    /// `timeout` option — typst has no cancellation hook and a Rust thread
    /// cannot be forcibly killed, so an option that looked like protection
    /// would only leak a wedged thread. Untrusted templates need *process*
    /// isolation (hard rule 3).
    pub fn run(self) -> Result<CompileOutput> {
        if let Some(error) = self.deferred {
            return Err(error);
        }

        let main_path = self.main.unwrap_or_else(|| {
            VfsPath::project(DEFAULT_MAIN).expect("DEFAULT_MAIN is a valid path")
        });
        let main = main_path.intern()?;

        if !self.overlay.contains(main) && !self.compiler.workspace.contains(main) {
            return Err(Error::MainNotFound { path: main_path.display() });
        }

        let options = self.settings.to_options(self.clock)?;
        let world = EmquadWorld {
            library: &self.compiler.library,
            fonts: &self.compiler.fonts,
            base: &self.compiler.workspace,
            overlay: &self.overlay,
            main,
            clock: self.clock,
        };

        let run = || catch_unwind(AssertUnwindSafe(|| export(&world, &options)));
        let caught = if self.compiler.pin_rayon { crate::rayon::pinned(run) } else { run() };

        caught.unwrap_or_else(|payload| Err(Error::Panic { message: panic_message(payload) }))
    }

    fn try_with(&mut self, f: impl FnOnce(&mut Self) -> Result<()>) {
        if self.deferred.is_some() {
            return;
        }
        if let Err(error) = f(self) {
            self.deferred = Some(error);
        }
    }
}

/// The output of a successful compile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileOutput {
    pub pdf: Vec<u8>,
    /// Warnings are surfaced on success too — they are the most likely place a
    /// silently-wrong document announces itself.
    pub warnings: Vec<Diagnostic>,
    pub pages: usize,
}

fn export(world: &EmquadWorld<'_>, options: &typst_pdf::PdfOptions) -> Result<CompileOutput> {
    let compiled = typst::compile::<PagedDocument>(world);
    let warnings = crate::diagnostics::convert(world, compiled.warnings);

    let document = match compiled.output {
        Ok(document) => document,
        Err(errors) => {
            let mut diagnostics = crate::diagnostics::convert(world, errors);
            // Warnings are appended rather than dropped: a warning is often the
            // explanation for the error above it. `severity` keeps them apart.
            diagnostics.extend(warnings);
            return Err(Error::Compile { diagnostics });
        }
    };

    match typst_pdf::pdf(&document, options) {
        Ok(pdf) => Ok(CompileOutput { pdf, warnings, pages: document.pages().len() }),
        Err(errors) => {
            let mut diagnostics = crate::diagnostics::convert(world, errors);
            diagnostics.extend(warnings);
            Err(Error::Export { diagnostics })
        }
    }
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "panic with a non-string payload".to_owned()
    }
}
