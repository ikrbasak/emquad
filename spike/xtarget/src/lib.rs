// Pulls in typst-eval -> stacker -> psm, the only per-arch assembly dependency.
pub fn touch() -> usize { std::mem::size_of::<typst_eval::Vm>() }
