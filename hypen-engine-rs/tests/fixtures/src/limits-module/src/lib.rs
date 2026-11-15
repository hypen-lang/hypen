// A deliberately misbehaving Hypen module, used to verify the host's sandbox:
// the per-call deadline (guest CPU *and* time blocked in host calls), the
// memory cap, storage isolation + quotas, and the cross-module request
// bounds. Never ship anything like this.
//
// Probe actions take a payload of fields separated by the ASCII unit
// separator (0x1F) so tests can pass arbitrary namespaces / keys verbatim.
wit_bindgen::generate!({
    world: "module-x",
    path: "../../../../../wit",
    generate_all,
});

use hypen::engine::state as xstate;
use hypen::storage::types::{Error as StorageError, Tier};
use hypen::storage::{app, local};

struct Module;

/// Park the guest inside a host call (`wasi:clocks` subscribe + `wasi:io`
/// poll) for far longer than any per-call budget. No guest code runs while
/// parked, so only a host-side deadline can end it.
fn block_in_host() -> ! {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60 * 60 * 24));
    }
}

fn fields(payload: &[u8]) -> Vec<String> {
    payload
        .split(|b| *b == 0x1f)
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect()
}

fn describe(e: StorageError) -> String {
    match e {
        StorageError::QuotaExceeded(over) => format!("quota-exceeded:{over}"),
        other => format!("{other:?}"),
    }
}

/// `scope` is "local" or "app"; both use the persistent tier.
fn kv_set(scope: &str, namespace: &str, key: &str, value: &[u8]) -> Result<(), String> {
    match scope {
        "local" => local::Bucket::open(Tier::Persistent, namespace)
            .and_then(|b| b.set(key, value))
            .map_err(describe),
        "app" => app::Bucket::open(Tier::Persistent, namespace)
            .and_then(|b| b.set(key, value))
            .map_err(describe),
        other => Err(format!("unknown scope: {other}")),
    }
}

fn kv_get(scope: &str, namespace: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
    match scope {
        "local" => local::Bucket::open(Tier::Persistent, namespace)
            .and_then(|b| b.get(key))
            .map_err(describe),
        "app" => app::Bucket::open(Tier::Persistent, namespace)
            .and_then(|b| b.get(key))
            .map_err(describe),
        other => Err(format!("unknown scope: {other}")),
    }
}

fn reply(text: String) -> Result<ReducerOutput, String> {
    Ok(ReducerOutput {
        state: Some(text.into_bytes()),
        effects: vec![],
        emit: vec![],
    })
}

impl Guest for Module {
    fn init(config: Vec<u8>) -> Result<Vec<u8>, String> {
        // `init("block")` parks in a host call — the deadline must cover
        // lifecycle entry points too, not just `dispatch`.
        if config == b"block" {
            block_in_host();
        }
        Ok(b"{\"count\":0}".to_vec())
    }

    fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        match action.name.as_str() {
            // Runs forever — the host's epoch deadline must trap this.
            "hang" => {
                let mut x: u64 = 0;
                loop {
                    x = x.wrapping_add(1);
                    std::hint::black_box(x);
                }
            }
            // Allocates far past the memory cap — memory.grow must be denied,
            // which aborts (traps) the module.
            "oom" => {
                let mut sink: Vec<Vec<u8>> = Vec::new();
                loop {
                    // 16 MiB at a time until the limiter says no.
                    sink.push(std::hint::black_box(vec![0u8; 16 * 1024 * 1024]));
                }
            }
            // Parks in a host call forever — epochs never fire here (no guest
            // code runs), so the host's wall-clock timeout must cancel it.
            "block" => block_in_host(),
            // payload: scope ␟ namespace ␟ key ␟ value. State becomes "ok"
            // or the storage error (e.g. "quota-exceeded:<bytes over>").
            "kv-set" => {
                let f = fields(&action.payload);
                if f.len() != 4 {
                    return Err("kv-set: scope, namespace, key, value".into());
                }
                reply(match kv_set(&f[0], &f[1], &f[2], f[3].as_bytes()) {
                    Ok(()) => "ok".into(),
                    Err(e) => e,
                })
            }
            // payload: scope ␟ namespace ␟ key ␟ size. Writes `size` bytes.
            "kv-fill" => {
                let f = fields(&action.payload);
                if f.len() != 4 {
                    return Err("kv-fill: scope, namespace, key, size".into());
                }
                let size: usize = f[3].parse().map_err(|e| format!("size: {e}"))?;
                reply(match kv_set(&f[0], &f[1], &f[2], &vec![b'x'; size]) {
                    Ok(()) => "ok".into(),
                    Err(e) => e,
                })
            }
            // payload: scope ␟ namespace ␟ key. State becomes "some:<value>"
            // or "none".
            "kv-get" => {
                let f = fields(&action.payload);
                if f.len() != 3 {
                    return Err("kv-get: scope, namespace, key".into());
                }
                reply(match kv_get(&f[0], &f[1], &f[2])? {
                    Some(v) => format!("some:{}", String::from_utf8_lossy(&v)),
                    None => "none".into(),
                })
            }
            // payload: target ␟ count ␟ payload-size. Requests `count`
            // cross-module dispatches of `payload-size` bytes each. State
            // becomes "<accepted>/<count>" plus the first refusal, if any.
            "flood-dispatch" => {
                let f = fields(&action.payload);
                if f.len() != 3 {
                    return Err("flood-dispatch: target, count, payload-size".into());
                }
                let count: usize = f[1].parse().map_err(|e| format!("count: {e}"))?;
                let size: usize = f[2].parse().map_err(|e| format!("size: {e}"))?;
                let payload = vec![b'x'; size];
                let mut accepted = 0;
                let mut refusal = String::new();
                for _ in 0..count {
                    let request = xstate::Action { name: "noop".into(), payload: payload.clone() };
                    match xstate::dispatch(&f[0], &request) {
                        Ok(()) => accepted += 1,
                        Err(e) => {
                            if refusal.is_empty() {
                                refusal = format!(" {e:?}");
                            }
                        }
                    }
                }
                reply(format!("{accepted}/{count}{refusal}"))
            }
            // payload: target ␟ count. Same, for `subscribe`.
            "flood-subscribe" => {
                let f = fields(&action.payload);
                if f.len() != 2 {
                    return Err("flood-subscribe: target, count".into());
                }
                let count: usize = f[1].parse().map_err(|e| format!("count: {e}"))?;
                let mut accepted = 0;
                let mut refusal = String::new();
                for i in 0..count {
                    match xstate::subscribe(&f[0], &format!("p{i}"), "noop") {
                        Ok(()) => accepted += 1,
                        Err(e) => {
                            if refusal.is_empty() {
                                refusal = format!(" {e:?}");
                            }
                        }
                    }
                }
                reply(format!("{accepted}/{count}{refusal}"))
            }
            // A well-behaved action so we can prove limits don't hurt normal use.
            "noop" => Ok(ReducerOutput {
                state: Some(state),
                effects: vec![],
                emit: vec![],
            }),
            other => Err(format!("unknown action: {other}")),
        }
    }

    fn on_activated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
    }
    fn on_deactivated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
    }
    fn on_destroyed(_state: Vec<u8>) -> Result<(), String> {
        Ok(())
    }
    fn actions() -> Vec<String> {
        [
            "hang",
            "oom",
            "block",
            "kv-set",
            "kv-fill",
            "kv-get",
            "flood-dispatch",
            "flood-subscribe",
            "noop",
        ]
        .map(String::from)
        .to_vec()
    }
}

export!(Module);
