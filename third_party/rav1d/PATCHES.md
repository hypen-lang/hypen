# Vendored rav1d: local patches

This directory is **rav1d 1.1.0 exactly as published on crates.io**
(`.cargo_vcs_info.json`: upstream commit
`782dab2135ea64a057c097088a13eb8ed3cc3320`), plus one patch. The workspace
uses it through `[patch.crates-io] rav1d = { path = "third_party/rav1d" }`
in the root `Cargo.toml` and excludes it from the workspace members.

Licence: rav1d is BSD-2-Clause (`COPYING`, kept unchanged, as are all
copyright notices in the sources). BSD-2 permits redistributing modified
source as long as the copyright notice, conditions and disclaimer are
retained, which they are; this file records what was modified.

Files added here (not in the upstream crate): `PATCHES.md`,
`hypen-c-unwind.patch`. Upstream's own `Cargo.toml` profiles (which set
`panic = "abort"`) and `rust-toolchain.toml` have no effect on a
dependency build and are kept as published. As a path dependency its
compiler warnings (about 36, all present upstream: function-pointer
comparisons in `wrap_fn_ptr!`'s derives, dead code, deprecations) are no
longer capped by cargo and show in builds of the desktop renderer; they
are left alone to keep the diff minimal.

## Patch: `extern "C"` -> `extern "C-unwind"` (`hypen-c-unwind.patch`)

**What.** Every `extern "C"` ABI in the crate's Rust code is changed to
`extern "C-unwind"`: the public `dav1d_*` entry points (`src/lib.rs`,
`dav1d_set_cpu_flags_mask` in `src/cpu.rs`), the public callback types
(`Dav1dLoggerCallback`, `Dav1dPicAllocator::{alloc,release}_picture_callback`,
`FnFree`) and their default implementations, the DSP function-pointer
types declared with `wrap_fn_ptr!` and every Rust fallback stored in them
(`*_c_erased`, `*_neon_erased`, `load_tmvs_c`, `pal_idx_finish_c`,
`rav1d_msac_decode_symbol_adapt_c`, ...), and the `extern` blocks declaring
the assembly kernels (feature `asm`; assembly never unwinds, so declaring
it `C-unwind` changes nothing for it). Doc comments (`/// ... extern "C"
fn ...`) are left alone. No other change: 154 lines, all ABI strings.

**Why.** Upstream rav1d's only public API is the `extern "C"` `dav1d_*`
functions (the Rust-level `rav1d_*` functions are `pub(crate)`), and rav1d
has roughly 500 `unwrap` / `assert!` / `panic!` / index sites reachable
from bitstream data. A panic cannot unwind out of an `extern "C"` function:
Rust aborts the process. The desktop renderer decodes AVIF images fetched
from remote servers, so one malformed file would kill the app (e.g. the
`f.frame_hdr.as_ref().unwrap()` in `src/decode.rs` after a single-threaded
frame decode). With `C-unwind`, the panic unwinds to the caller's
`std::panic::catch_unwind` (`hypen-renderer-desktop/src/paint/avif.rs`).
The DSP function pointers have to change too: in a build without `asm`
they point at Rust code (bounds-checked slices, `unimplemented!()`
defaults), and a panic inside one would otherwise abort at that `extern
"C"` frame.

This relies on `panic = "unwind"` (the default; no profile in this
workspace sets `abort`). A build with `panic = "abort"` aborts on these
panics whatever the ABI.

## Re-applying on upgrade

1. Copy the new crate from the registry:
   `cp -a ~/.cargo/registry/src/*/rav1d-<ver> third_party/rav1d.new`
   (or unpack the `.crate` from crates.io), delete `.cargo-ok`.
2. Re-apply the change. It is mechanical, so the substitution is more
   robust across versions than the patch file:

   ```sh
   cd third_party/rav1d.new
   grep -rl 'extern "C"' --include=*.rs . | xargs sed -i \
     '/^\s*\/\//! s/extern "C"\([ {(]\)/extern "C-unwind"\1/g'
   grep -rn 'extern "C"[^-]' --include=*.rs .   # only doc comments left
   ```

   For 1.1.0 the result is exactly `hypen-c-unwind.patch`
   (`patch -p1 < hypen-c-unwind.patch` from inside a pristine copy).
3. Regenerate the patch against the pristine crate
   (`diff -ru rav1d-<ver> rav1d > hypen-c-unwind.patch`), copy `PATCHES.md`
   over, update the version above, replace `third_party/rav1d`, and run
   `cargo update -p rav1d`.
4. Check: `cargo test -p hypen-renderer-desktop --lib avif` — the
   malformed-AVIF corpus must decode in-process with at least one caught
   rav1d panic, and the test binary must not abort.

Drop this vendoring once upstream exposes unwinding entry points or a Rust
API that returns errors instead of panicking.
