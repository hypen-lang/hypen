//! The on-disk compilation cache directory: what it is and when it is safe.
//!
//! With a cache directory configured, wasmtime stores each compiled
//! component there and later processes load it instead of recompiling
//! (`Config::cache`; for components too as of wasmtime 46). The cache is
//! wasmtime's own, so its keying is too: entries live under a directory named
//! after the wasmtime version, and each is addressed by a SHA-256 over the
//! component bytes **and** the engine's whole compilation environment
//! (target — so Cranelift and Pulley never share entries — compiler flags,
//! tunables, enabled wasm features). A loaded artifact's own header is then
//! checked against the running engine again. A stale or foreign artifact is
//! therefore never used; it is simply not found, and the component is
//! compiled.
//!
//! ## Trust
//!
//! A cache entry is **native code this process will execute** (or, under the
//! interpreter, bytecode it will trust). wasmtime verifies that an entry is
//! *compatible*, not that it is *authentic*: whoever can write a file into
//! the cache directory can run code as the user running the host. So the
//! cache is **opt-in** — nothing is read from disk unless the embedder names
//! a directory — and [`prepare`] refuses a directory that fails the checks it
//! can make:
//!
//! - it must be (or resolve to) a directory, created `0700` if missing;
//! - on Unix it must not be writable by group or others, and it must be
//!   owned by the user this process creates files as.
//!
//! What is *not* checked, and is the embedder's assumption to uphold: that no
//! ancestor of the directory lets another user replace it, and (on non-Unix
//! platforms, where no permission check is made) that the location is private
//! to the user. Do not point two mutually distrusting users at one cache.

use std::path::{Path, PathBuf};

use crate::module_host::HostError;

fn refuse(dir: &Path, why: impl std::fmt::Display) -> HostError {
    HostError::Runtime(format!(
        "compilation cache directory {}: {why}",
        dir.display()
    ))
}

/// Create (if needed), resolve and vet the cache directory. Returns its
/// canonical absolute path.
pub(crate) fn prepare(dir: &Path) -> Result<PathBuf, HostError> {
    let absolute = std::path::absolute(dir).map_err(|e| refuse(dir, e))?;
    if !absolute.exists() {
        create_private(&absolute).map_err(|e| refuse(dir, format!("cannot create it: {e}")))?;
    }
    let canonical = std::fs::canonicalize(&absolute).map_err(|e| refuse(dir, e))?;
    let meta = std::fs::metadata(&canonical).map_err(|e| refuse(dir, e))?;
    if !meta.is_dir() {
        return Err(refuse(dir, "is not a directory"));
    }
    check_private(&canonical, &meta).map_err(|why| refuse(dir, why))?;
    Ok(canonical)
}

#[cfg(unix)]
fn create_private(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    // Ancestors get the process default; only the cache directory itself
    // must be private.
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        // Lost a race with another process creating it: vetted below.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        other => other,
    }
}

#[cfg(not(unix))]
fn create_private(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

#[cfg(unix)]
fn check_private(dir: &Path, meta: &std::fs::Metadata) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;

    let mode = meta.mode() & 0o777;
    if mode & 0o022 != 0 {
        return Err(format!(
            "is writable by other users (mode {mode:03o}), and cached code is executed as \
             you; `chmod 700` it or choose a private directory"
        ));
    }
    // Whose files are ours? Ask the filesystem rather than link libc for
    // `geteuid`: a file we create is owned by the user we run as.
    let probe = tempfile_in(dir).map_err(|e| format!("is not writable: {e}"))?;
    let ours = std::fs::metadata(&probe).map(|m| m.uid());
    let _ = std::fs::remove_file(&probe);
    let ours = ours.map_err(|e| format!("cannot be inspected: {e}"))?;
    if meta.uid() != ours {
        return Err(format!(
            "is owned by another user (uid {}, this process runs as uid {ours}), and cached \
             code is executed as you; choose a directory you own",
            meta.uid()
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_private(_dir: &Path, _meta: &std::fs::Metadata) -> Result<(), String> {
    // No portable permission model to check; see the module docs.
    Ok(())
}

/// Create a uniquely named empty file in `dir` and return its path.
#[cfg(unix)]
fn tempfile_in(dir: &Path) -> std::io::Result<PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    for _ in 0..16 {
        let name = format!(
            ".hypen-owner-probe-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let path = dir.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("no free probe file name"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_directory_is_created_private_and_canonical() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("a").join("cache");
        let prepared = prepare(&dir).unwrap();
        assert_eq!(prepared, std::fs::canonicalize(&dir).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
            // The ownership probe cleans up after itself.
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        }
        // Preparing it again is fine.
        prepare(&dir).unwrap();
    }

    #[test]
    fn a_file_is_not_a_cache_directory() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("cache");
        std::fs::write(&file, "x").unwrap();
        let err = prepare(&file).unwrap_err().to_string();
        assert!(err.contains("is not a directory"), "{err}");
        assert!(err.contains("cache"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_others_can_write_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        for mode in [0o777, 0o775, 0o757] {
            let dir = root.path().join(format!("shared-{mode:o}"));
            std::fs::create_dir(&dir).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();
            let err = prepare(&dir).unwrap_err().to_string();
            assert!(err.contains("writable by other users"), "{mode:o}: {err}");
            assert!(err.contains("chmod 700"), "{err}");
        }
        // Readable by others is fine: compiled code is not a secret.
        let dir = root.path().join("readable");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        prepare(&dir).unwrap();
    }
}
