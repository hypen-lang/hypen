//! Bluetooth helpers shared by `bluetooth.scan` and `bluetooth.select`:
//! opaque device ids, the chooser's filters, and scan-event coalescing.
//!
//! **Device ids are opaque.** The platform identifier is a MAC address on
//! Linux (BlueZ) and Windows (WinRT) — a stable hardware identifier that
//! tracks a person across apps — while iOS (`CBPeripheral.identifier`) and
//! the web (`BluetoothDevice.id`) expose per-app / per-origin random ids.
//! The desktop matches them: the wire id is a UUID-shaped keyed hash of
//! `(per-install secret, server origin, platform id)`, stable for one
//! origin on one machine (a server can recognise a device it saw before),
//! unlinkable across origins, and never the MAC itself.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

/// Chooser entries listed at once.
pub const MAX_LISTED: usize = 64;

/// A 32-byte per-install secret: read from (or created in) the user's local
/// data directory; a per-process secret when that is not writable.
pub fn install_secret() -> [u8; 32] {
    static SECRET: OnceLock<[u8; 32]> = OnceLock::new();
    *SECRET.get_or_init(|| {
        // Unit tests never touch the user's data directory.
        if cfg!(test) {
            return random_secret();
        }
        let path = dirs::data_local_dir().map(|d| d.join("hypen").join("device-id-secret"));
        if let Some(path) = &path {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(secret) = <[u8; 32]>::try_from(bytes.as_slice()) {
                    return secret;
                }
            }
        }
        let secret = random_secret();
        if let Some(path) = path {
            let _ = store_secret(&path, &secret);
        }
        secret
    })
}

fn store_secret(path: &PathBuf, secret: &[u8; 32]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    opts.open(path)?.write_all(secret)
}

/// 256 bits from the OS-seeded hasher keys (std's `RandomState` draws its
/// keys from the platform CSPRNG), mixed with time and pid.
fn random_secret() -> [u8; 32] {
    let mut h = Sha256::new();
    for i in 0..8u64 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(i);
        h.update(hasher.finish().to_le_bytes());
    }
    if let Ok(t) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        h.update(t.as_nanos().to_le_bytes());
    }
    h.update(std::process::id().to_le_bytes());
    h.finalize().into()
}

/// The wire id of a device: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (lowercase
/// hex of a keyed SHA-256), stable per `(secret, origin, raw_id)`.
pub fn opaque_id(secret: &[u8; 32], origin: &str, raw_id: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"hypen-ble-id\0");
    h.update(secret);
    h.update((origin.len() as u64).to_le_bytes());
    h.update(origin.as_bytes());
    h.update(raw_id.as_bytes());
    let d = h.finalize();
    let hex: String = d[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// `s` bounded to `max` code points.
pub fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// A device name as the wire carries it (≤ 256 code points, no empty).
pub fn clean_name(name: Option<&str>) -> Option<String> {
    name.map(|n| truncate_chars(n, 256))
        .filter(|n| !n.is_empty())
}

/// `bluetooth.select` filters (RFC 001 §3): a device must advertise EVERY
/// listed service (like one Web Bluetooth filter) and its name must start
/// with `namePrefix` by exact code points; an unnamed device never matches
/// a prefix.
pub fn passes_filters(
    name: Option<&str>,
    advertised: &[String],
    services: &[String],
    prefix: Option<&str>,
) -> bool {
    if let Some(p) = prefix {
        match name {
            Some(n) if n.starts_with(p) => {}
            _ => return false,
        }
    }
    services.iter().all(|want| {
        advertised
            .iter()
            .any(|have| have.eq_ignore_ascii_case(want))
    })
}

struct Seen {
    at_ms: u64,
    rssi: i16,
    name: Option<String>,
    order: u64,
}

/// `bluetooth.scan` event coalescing, as on Android: a device is reported
/// on first sight, then again only after `min_interval_ms`, an RSSI change
/// of at least `rssi_delta_db`, or a newly learned name. Tracks at most
/// `max_tracked` devices (least recently seen evicted).
pub struct Coalescer {
    min_interval_ms: u64,
    rssi_delta_db: i16,
    max_tracked: usize,
    seen: HashMap<String, Seen>,
    tick: u64,
}

impl Default for Coalescer {
    fn default() -> Self {
        Coalescer::new(1_000, 6, 512)
    }
}

impl Coalescer {
    pub fn new(min_interval_ms: u64, rssi_delta_db: i16, max_tracked: usize) -> Self {
        Coalescer {
            min_interval_ms,
            rssi_delta_db,
            max_tracked: max_tracked.max(1),
            seen: HashMap::new(),
            tick: 0,
        }
    }

    /// The event to emit for this sighting, if any: `{device:{id,name?,rssi}}`.
    pub fn offer(
        &mut self,
        id: &str,
        name: Option<&str>,
        rssi: i16,
        now_ms: u64,
    ) -> Option<serde_json::Value> {
        self.tick += 1;
        let name = clean_name(name);
        let emit_name = match self.seen.get_mut(id) {
            Some(prev) => {
                let new_name = name.is_some() && name != prev.name;
                let due = now_ms.saturating_sub(prev.at_ms) >= self.min_interval_ms
                    || (rssi - prev.rssi).abs() >= self.rssi_delta_db;
                prev.order = self.tick;
                if !due && !new_name {
                    return None;
                }
                prev.at_ms = now_ms;
                prev.rssi = rssi;
                if name.is_some() {
                    prev.name = name;
                }
                prev.name.clone()
            }
            None => {
                if self.seen.len() >= self.max_tracked {
                    if let Some(oldest) = self
                        .seen
                        .iter()
                        .min_by_key(|(_, s)| s.order)
                        .map(|(k, _)| k.clone())
                    {
                        self.seen.remove(&oldest);
                    }
                }
                self.seen.insert(
                    id.to_string(),
                    Seen {
                        at_ms: now_ms,
                        rssi,
                        name: name.clone(),
                        order: self.tick,
                    },
                );
                name
            }
        };
        let mut device = serde_json::Map::new();
        device.insert("id".into(), serde_json::Value::String(id.to_string()));
        if let Some(n) = emit_name {
            device.insert("name".into(), serde_json::Value::String(n));
        }
        device.insert("rssi".into(), serde_json::Value::from(rssi));
        Some(serde_json::json!({ "device": device }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_ids_are_stable_per_origin_and_never_the_mac() {
        let secret = [7u8; 32];
        let mac = "AA:BB:CC:DD:EE:FF";
        let a = opaque_id(&secret, "wss://a.example", mac);
        assert_eq!(a, opaque_id(&secret, "wss://a.example", mac));
        assert_ne!(
            a,
            opaque_id(&secret, "wss://b.example", mac),
            "unlinkable across origins"
        );
        assert_ne!(
            a,
            opaque_id(&[8u8; 32], "wss://a.example", mac),
            "keyed by the install secret"
        );
        assert!(!a.to_ascii_uppercase().contains("AABBCC"));
        assert_eq!(a.len(), 36);
        assert!(a.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
    }

    #[test]
    fn filters_need_every_service_and_an_exact_prefix() {
        let hr = "0000180d-0000-1000-8000-00805f9b34fb".to_string();
        let bat = "0000180f-0000-1000-8000-00805f9b34fb".to_string();
        let adv = vec![hr.clone(), bat.clone()];
        assert!(passes_filters(
            Some("Polar H10"),
            &adv,
            std::slice::from_ref(&hr),
            Some("Polar")
        ));
        assert!(passes_filters(
            Some("Polar H10"),
            &adv,
            &[hr.clone(), bat.clone()],
            None
        ));
        assert!(!passes_filters(
            Some("Polar H10"),
            std::slice::from_ref(&hr),
            &[hr.clone(), bat],
            None
        ));
        assert!(
            !passes_filters(Some("polar"), &adv, &[], Some("Polar")),
            "case-sensitive"
        );
        assert!(
            !passes_filters(None, &adv, &[], Some("P")),
            "unnamed never matches a prefix"
        );
        assert!(passes_filters(None, &[], &[], None));
        // Precomposed vs decomposed é are different code points.
        assert!(!passes_filters(
            Some("e\u{301}cho"),
            &[],
            &[],
            Some("\u{e9}")
        ));
    }

    #[test]
    fn coalescing_reports_first_sight_rssi_jumps_names_and_intervals() {
        let mut c = Coalescer::new(1_000, 6, 2);
        let first = c.offer("d1", None, -60, 0).unwrap();
        assert_eq!(first, serde_json::json!({"device":{"id":"d1","rssi":-60}}));
        assert!(c.offer("d1", None, -62, 100).is_none());
        assert!(c.offer("d1", None, -67, 200).is_some(), "6 dB change");
        let named = c.offer("d1", Some("Tag"), -67, 300).unwrap();
        assert_eq!(named["device"]["name"], "Tag");
        // The name sticks for later reports without one.
        let later = c.offer("d1", None, -67, 1_400).unwrap();
        assert_eq!(later["device"]["name"], "Tag");
        // Bounded tracking: a third device evicts the least recently seen.
        c.offer("d2", None, -50, 1_500);
        c.offer("d3", None, -50, 1_600);
        assert!(
            c.offer("d1", None, -67, 1_700).is_some(),
            "d1 was evicted, so it is new again"
        );
    }
}
