use indexmap::IndexMap;
use std::sync::Arc;

/// A cached resource (image, font, etc.)
#[derive(Clone)]
pub struct Resource {
    /// Resource data (platform-specific)
    pub data: Arc<Vec<u8>>,

    /// MIME type
    pub mime_type: String,

    /// Optional fingerprint/hash for cache validation
    pub fingerprint: Option<String>,
}

impl Resource {
    pub fn new(data: Vec<u8>, mime_type: impl Into<String>) -> Self {
        Self {
            data: Arc::new(data),
            mime_type: mime_type.into(),
            fingerprint: None,
        }
    }

    pub fn with_fingerprint(mut self, fingerprint: impl Into<String>) -> Self {
        self.fingerprint = Some(fingerprint.into());
        self
    }
}

/// Callback for fetching resources (abstracted so platforms can override)
pub type ResourceFetcher = Box<dyn Fn(&str) -> Option<Resource> + Send + Sync>;

/// Cache for resources (images, fonts, etc.)
pub struct ResourceCache {
    /// Cached resources by URL/key
    cache: IndexMap<String, Resource>,

    /// Fetcher function (can be overridden by platform)
    fetcher: Option<ResourceFetcher>,
}

impl ResourceCache {
    pub fn new() -> Self {
        Self {
            cache: IndexMap::new(),
            fetcher: None,
        }
    }

    /// Set a custom resource fetcher
    pub fn set_fetcher<F>(&mut self, fetcher: F)
    where
        F: Fn(&str) -> Option<Resource> + Send + Sync + 'static,
    {
        self.fetcher = Some(Box::new(fetcher));
    }

    /// Get a resource by URL/key
    pub fn get(&mut self, url: &str) -> Option<Resource> {
        // Check cache first
        if let Some(resource) = self.cache.get(url) {
            return Some(resource.clone());
        }

        // Try to fetch using the fetcher
        if let Some(ref fetcher) = self.fetcher {
            if let Some(resource) = fetcher(url) {
                self.cache.insert(url.to_string(), resource.clone());
                return Some(resource);
            }
        }

        None
    }

    /// Manually insert a resource into the cache
    pub fn insert(&mut self, url: impl Into<String>, resource: Resource) {
        self.cache.insert(url.into(), resource);
    }

    /// Clear the cache
    pub fn clear(&mut self) {
        self.cache.clear();
    }

    /// Remove a specific resource
    pub fn remove(&mut self, url: &str) -> Option<Resource> {
        self.cache.shift_remove(url)
    }

    /// Get cache size (number of entries)
    pub fn size(&self) -> usize {
        self.cache.len()
    }
}

impl Default for ResourceCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_insert_get() {
        let mut cache = ResourceCache::new();
        let resource = Resource::new(vec![1, 2, 3], "image/png");

        cache.insert("test.png", resource.clone());

        let retrieved = cache.get("test.png").unwrap();
        assert_eq!(*retrieved.data, vec![1, 2, 3]);
        assert_eq!(retrieved.mime_type, "image/png");
    }

    #[test]
    fn test_custom_fetcher() {
        let mut cache = ResourceCache::new();

        cache.set_fetcher(|url| {
            if url == "auto.png" {
                Some(Resource::new(vec![4, 5, 6], "image/png"))
            } else {
                None
            }
        });

        let resource = cache.get("auto.png").unwrap();
        assert_eq!(*resource.data, vec![4, 5, 6]);

        // Should be cached now
        assert_eq!(cache.size(), 1);
    }
}
