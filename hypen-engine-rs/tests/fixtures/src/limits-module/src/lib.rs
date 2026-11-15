// A deliberately misbehaving Hypen module, used to verify the host's resource
// limits (epoch timeout + memory cap). Never ship anything like this.
wit_bindgen::generate!({
    world: "module",
    path: "../../../../../wit",
    generate_all,
});

struct Module;

impl Guest for Module {
    fn init(_config: Vec<u8>) -> Result<Vec<u8>, String> {
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
        vec!["hang".into(), "oom".into(), "noop".into()]
    }
}

export!(Module);
