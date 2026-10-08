//! Cost of fingerprinting list items for the iterable memo.
//!
//! A wholesale array replacement fingerprints every item even when every
//! row is a memo hit, so the per-item hash is the floor of that pass.
//! `serialize` is the previous implementation (serde_json written into a
//! hasher: number formatting, string escaping); `structural` is the one
//! shipped in `reconcile::keyed::item_fingerprint`.
//!
//! Run with: cargo bench --bench item_fingerprint

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use serde_json::json;
use std::hash::Hasher;

struct HashWriter(std::collections::hash_map::DefaultHasher);
impl std::io::Write for HashWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialize_fingerprint(item: &serde_json::Value) -> u64 {
    let mut w = HashWriter(std::collections::hash_map::DefaultHasher::new());
    if serde_json::to_writer(&mut w, item).is_err() {
        w.0.write_u64(u64::MAX);
    }
    w.0.finish()
}

fn items(n: usize) -> Vec<serde_json::Value> {
    (0..n)
        .map(|i| {
            json!({
                "id": i,
                "title": format!("Post number {i} with a \"quoted\" title"),
                "author": {"name": format!("user{i}"), "verified": i % 3 == 0},
                "likes": i * 7,
                "score": (i as f64) * 0.37,
                "tags": ["one", "two", "three"],
            })
        })
        .collect()
}

fn bench(c: &mut Criterion) {
    let mut group = c.benchmark_group("item_fingerprint");
    for &n in &[100usize, 1_000, 10_000] {
        let rows = items(n);
        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(BenchmarkId::new("serialize", n), &rows, |b, rows| {
            b.iter(|| {
                let mut acc = 0u64;
                for item in rows {
                    acc ^= serialize_fingerprint(black_box(item));
                }
                acc
            })
        });
        group.bench_with_input(BenchmarkId::new("structural", n), &rows, |b, rows| {
            b.iter(|| {
                let mut acc = 0u64;
                for item in rows {
                    acc ^= hypen_engine::reconcile::keyed::item_fingerprint(black_box(item));
                }
                acc
            })
        });
    }
    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
