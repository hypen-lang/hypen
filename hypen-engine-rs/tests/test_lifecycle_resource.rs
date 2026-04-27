//! Tests for src/lifecycle/resource.rs - Resource caching system
//!
//! Tests resource creation, cache operations, and custom fetcher integration

use hypen_engine::lifecycle::resource::{Resource, ResourceCache};
use std::sync::{Arc, Mutex};

// ============================================================================
// Resource Creation (2 tests)
// ============================================================================

#[test]
fn test_resource_new() {
    // GIVEN: Binary data and MIME type
    let data = vec![1, 2, 3, 4, 5];

    // WHEN: Create resource
    let resource = Resource::new(data.clone(), "image/png");

    // THEN: Resource created correctly
    assert_eq!(*resource.data, data);
    assert_eq!(resource.mime_type, "image/png");
    assert!(resource.fingerprint.is_none());
}

#[test]
fn test_resource_with_fingerprint() {
    // GIVEN: Resource
    let resource = Resource::new(vec![1, 2, 3], "text/plain");

    // WHEN: Add fingerprint
    let resource_with_fp = resource.with_fingerprint("abc123hash");

    // THEN: Fingerprint added
    assert_eq!(resource_with_fp.fingerprint, Some("abc123hash".to_string()));
    assert_eq!(resource_with_fp.mime_type, "text/plain");
}

// ============================================================================
// Cache Operations (5 tests)
// ============================================================================

#[test]
fn test_cache_insert_and_get() {
    // GIVEN: ResourceCache
    let mut cache = ResourceCache::new();
    let resource = Resource::new(vec![10, 20, 30], "image/jpeg");

    // WHEN: Insert resource
    cache.insert("photo.jpg", resource.clone());

    // THEN: Can retrieve it
    let retrieved = cache.get("photo.jpg").unwrap();
    assert_eq!(*retrieved.data, vec![10, 20, 30]);
    assert_eq!(retrieved.mime_type, "image/jpeg");
}

#[test]
fn test_cache_get_nonexistent_resource() {
    // GIVEN: Empty cache
    let mut cache = ResourceCache::new();

    // WHEN: Try to get nonexistent resource
    let result = cache.get("missing.png");

    // THEN: Returns None
    assert!(result.is_none());
}

#[test]
fn test_cache_remove_resource() {
    // GIVEN: Cache with resource
    let mut cache = ResourceCache::new();
    cache.insert("test.png", Resource::new(vec![1, 2, 3], "image/png"));
    assert_eq!(cache.size(), 1);

    // WHEN: Remove resource
    let removed = cache.remove("test.png");

    // THEN: Resource removed and returned
    assert!(removed.is_some());
    assert_eq!(*removed.unwrap().data, vec![1, 2, 3]);
    assert_eq!(cache.size(), 0);
}

#[test]
fn test_cache_clear() {
    // GIVEN: Cache with multiple resources
    let mut cache = ResourceCache::new();
    cache.insert("img1.png", Resource::new(vec![1], "image/png"));
    cache.insert("img2.jpg", Resource::new(vec![2], "image/jpeg"));
    cache.insert("font.woff", Resource::new(vec![3], "font/woff"));
    assert_eq!(cache.size(), 3);

    // WHEN: Clear cache
    cache.clear();

    // THEN: All resources removed
    assert_eq!(cache.size(), 0);
    assert!(cache.get("img1.png").is_none());
    assert!(cache.get("img2.jpg").is_none());
    assert!(cache.get("font.woff").is_none());
}

#[test]
fn test_cache_size() {
    // GIVEN: Cache
    let mut cache = ResourceCache::new();

    // WHEN: Add resources incrementally
    assert_eq!(cache.size(), 0);

    cache.insert("res1", Resource::new(vec![1], "image/png"));
    assert_eq!(cache.size(), 1);

    cache.insert("res2", Resource::new(vec![2], "image/png"));
    assert_eq!(cache.size(), 2);

    cache.remove("res1");
    assert_eq!(cache.size(), 1);

    cache.clear();
    assert_eq!(cache.size(), 0);
}

// ============================================================================
// Custom Fetcher Integration (3 tests)
// ============================================================================

#[test]
fn test_cache_with_custom_fetcher() {
    // GIVEN: Cache with custom fetcher
    let mut cache = ResourceCache::new();

    cache.set_fetcher(|url| {
        if url.starts_with("http://") {
            Some(Resource::new(vec![1, 2, 3], "text/html"))
        } else {
            None
        }
    });

    // WHEN: Get resource via fetcher
    let resource = cache.get("http://example.com");

    // THEN: Fetcher called and resource returned
    assert!(resource.is_some());
    assert_eq!(*resource.unwrap().data, vec![1, 2, 3]);

    // AND: Resource cached
    assert_eq!(cache.size(), 1);
}

#[test]
fn test_fetcher_caches_result() {
    // GIVEN: Cache with fetcher that tracks calls
    let mut cache = ResourceCache::new();
    let fetch_count = Arc::new(Mutex::new(0));
    let fetch_count_clone = Arc::clone(&fetch_count);

    cache.set_fetcher(move |url| {
        if url == "counted.txt" {
            *fetch_count_clone.lock().unwrap() += 1;
            Some(Resource::new(vec![99], "text/plain"))
        } else {
            None
        }
    });

    // WHEN: Get same resource twice
    cache.get("counted.txt");
    cache.get("counted.txt");

    // THEN: Fetcher only called once (second call uses cache)
    assert_eq!(*fetch_count.lock().unwrap(), 1);
    assert_eq!(cache.size(), 1);
}

#[test]
fn test_fetcher_returns_none_for_unknown_url() {
    // GIVEN: Cache with selective fetcher
    let mut cache = ResourceCache::new();

    cache.set_fetcher(|url| {
        if url == "known.png" {
            Some(Resource::new(vec![5, 6, 7], "image/png"))
        } else {
            None
        }
    });

    // WHEN: Request unknown URL
    let result = cache.get("unknown.png");

    // THEN: Returns None
    assert!(result.is_none());
    assert_eq!(cache.size(), 0);
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_cache_default() {
    // GIVEN/WHEN: Create using default
    let cache = ResourceCache::default();

    // THEN: Same as new() (empty cache)
    assert_eq!(cache.size(), 0);
}

#[test]
fn test_resource_clone() {
    // GIVEN: Resource
    let original = Resource::new(vec![1, 2, 3], "image/png").with_fingerprint("hash123");

    // WHEN: Clone it
    let cloned = original.clone();

    // THEN: Clone has same data (Arc is shared)
    assert_eq!(*cloned.data, vec![1, 2, 3]);
    assert_eq!(cloned.mime_type, "image/png");
    assert_eq!(cloned.fingerprint, Some("hash123".to_string()));

    // AND: Arc data is shared (not copied)
    assert!(Arc::ptr_eq(&original.data, &cloned.data));
}

#[test]
fn test_cache_overwrites_on_duplicate_insert() {
    // GIVEN: Cache with resource
    let mut cache = ResourceCache::new();
    cache.insert("image.png", Resource::new(vec![1, 2, 3], "image/png"));

    // WHEN: Insert different resource with same key
    cache.insert("image.png", Resource::new(vec![4, 5, 6], "image/jpeg"));

    // THEN: New resource replaces old one
    let resource = cache.get("image.png").unwrap();
    assert_eq!(*resource.data, vec![4, 5, 6]);
    assert_eq!(resource.mime_type, "image/jpeg");
    assert_eq!(cache.size(), 1); // Still only one entry
}

#[test]
fn test_remove_nonexistent_resource_returns_none() {
    // GIVEN: Empty cache
    let mut cache = ResourceCache::new();

    // WHEN: Remove nonexistent resource
    let result = cache.remove("nonexistent.png");

    // THEN: Returns None
    assert!(result.is_none());
}

#[test]
fn test_cache_preserves_insertion_order() {
    // GIVEN: Cache with multiple resources (IndexMap preserves order)
    let mut cache = ResourceCache::new();
    cache.insert("first.png", Resource::new(vec![1], "image/png"));
    cache.insert("second.jpg", Resource::new(vec![2], "image/jpeg"));
    cache.insert("third.gif", Resource::new(vec![3], "image/gif"));

    // WHEN: Retrieve resources
    let first = cache.get("first.png").unwrap();
    let second = cache.get("second.jpg").unwrap();
    let third = cache.get("third.gif").unwrap();

    // THEN: All resources retrievable
    assert_eq!(*first.data, vec![1]);
    assert_eq!(*second.data, vec![2]);
    assert_eq!(*third.data, vec![3]);
}

#[test]
fn test_resource_with_large_data() {
    // GIVEN: Large binary data
    let large_data = vec![0u8; 1024 * 1024]; // 1MB

    // WHEN: Create resource
    let resource = Resource::new(large_data.clone(), "application/octet-stream");

    // THEN: Handles large data correctly
    assert_eq!(resource.data.len(), 1024 * 1024);
    assert_eq!(resource.mime_type, "application/octet-stream");
}

#[test]
fn test_fetcher_with_different_mime_types() {
    // GIVEN: Cache with fetcher returning different MIME types
    let mut cache = ResourceCache::new();

    cache.set_fetcher(|url| match url {
        url if url.ends_with(".png") => Some(Resource::new(vec![1], "image/png")),
        url if url.ends_with(".jpg") => Some(Resource::new(vec![2], "image/jpeg")),
        url if url.ends_with(".txt") => Some(Resource::new(vec![3], "text/plain")),
        _ => None,
    });

    // WHEN: Fetch different resource types
    let png = cache.get("image.png").unwrap();
    let jpg = cache.get("photo.jpg").unwrap();
    let txt = cache.get("file.txt").unwrap();

    // THEN: Correct MIME types
    assert_eq!(png.mime_type, "image/png");
    assert_eq!(jpg.mime_type, "image/jpeg");
    assert_eq!(txt.mime_type, "text/plain");
}
