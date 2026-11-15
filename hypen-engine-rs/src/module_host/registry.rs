//! Module discovery. Where a [`ModuleHost`](super::ModuleHost) gets the
//! component bytes for a module name + version.
//!
//! v1.0 ships [`BundledRegistry`] (bytes embedded in the app). A network
//! fetcher and filesystem registry slot in behind the same trait later;
//! see `/wit/ENGINE_INTEGRATION.md` "Module discovery & registry".

use std::collections::HashMap;
use std::fmt;

/// Errors resolving a module from a registry.
#[derive(Debug)]
pub enum RegistryError {
    NotFound { name: String, version: String },
    NotSupported,
    Io(String),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegistryError::NotFound { name, version } => {
                write!(f, "module not found: {name}@{version}")
            }
            RegistryError::NotSupported => write!(f, "operation not supported by this registry"),
            RegistryError::Io(e) => write!(f, "registry io error: {e}"),
        }
    }
}

impl std::error::Error for RegistryError {}

/// Resolves module names+versions to component bytes.
pub trait ModuleRegistry: Send {
    /// Resolve a module by name and semver-ish version string.
    fn resolve(&self, name: &str, version: &str) -> Result<Vec<u8>, RegistryError>;

    /// Optionally enumerate known modules (for startup preloading).
    fn list(&self) -> Result<Vec<(String, String)>, RegistryError> {
        Err(RegistryError::NotSupported)
    }
}

/// In-memory registry of bytes bundled with the app at build time. The CLI's
/// `build` step populates one of these from the app's module-instantiation
/// sites.
#[derive(Default)]
pub struct BundledRegistry {
    modules: HashMap<(String, String), Vec<u8>>,
}

impl BundledRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add (or replace) a module's bytes under `name@version`.
    pub fn insert(&mut self, name: impl Into<String>, version: impl Into<String>, bytes: Vec<u8>) {
        self.modules.insert((name.into(), version.into()), bytes);
    }

    pub fn with(mut self, name: impl Into<String>, version: impl Into<String>, bytes: Vec<u8>) -> Self {
        self.insert(name, version, bytes);
        self
    }
}

impl ModuleRegistry for BundledRegistry {
    fn resolve(&self, name: &str, version: &str) -> Result<Vec<u8>, RegistryError> {
        self.modules
            .get(&(name.to_string(), version.to_string()))
            .cloned()
            .ok_or_else(|| RegistryError::NotFound {
                name: name.to_string(),
                version: version.to_string(),
            })
    }

    fn list(&self) -> Result<Vec<(String, String)>, RegistryError> {
        Ok(self.modules.keys().cloned().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_resolve_roundtrip() {
        let reg = BundledRegistry::new().with("counter", "1.0.0", vec![1, 2, 3]);
        assert_eq!(reg.resolve("counter", "1.0.0").unwrap(), vec![1, 2, 3]);
        assert!(reg.resolve("counter", "2.0.0").is_err());
        assert!(reg.resolve("missing", "1.0.0").is_err());
    }
}
