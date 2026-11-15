//! `hypen-runtime` — host `hypen:module` WASM Components and drive them from
//! a REPL or over HTTP.
//!
//! This is the "ship your whole app as a .wasm" reference runtime: the same
//! engine and wasmtime host an embedder links, packaged as a binary. Run it
//! with `--help` for the flags; the modules below are the table of contents:
//!
//! | module | responsibility |
//! |---|---|
//! | [`cli`] | `argv` → a typed [`cli::Command`]; usage text |
//! | [`names`] | validated scope / component name newtypes |
//! | [`manifest`] | `app.json` → a validated [`manifest::AppManifest`] |
//! | [`template`] | pure helpers over `.hypen` source (config, renames) |
//! | [`usage_plan`] | one instance per distinct usage config + template rewriting |
//! | [`app`] | [`app::Runtime`]: engine + hosted modules; boot, dispatch, crash recovery |
//! | [`patches`] | [`patches::PatchHub`]: tree mirror, exact patch attribution, SSE fan-out |
//! | [`effects`] | draining `Navigate` / `Delay` effects |
//! | [`timers`] | the single timer thread behind `Delay` |
//! | [`reload`] | `.wasm` / `.hypen` hot reload and the file watcher |
//! | [`server`] | `--serve`: admission policy, routes, SSE |
//! | [`repl`] | the stdin REPL |
//! | [`error`] | [`error::RuntimeError`] and its rendering |
//! | [`sync`] | the mutex-poisoning policy |

mod app;
mod cli;
mod effects;
mod error;
mod manifest;
mod names;
mod patches;
mod reload;
mod repl;
mod server;
mod sync;
mod template;
mod timers;
mod usage_plan;

use std::process::ExitCode;
use std::sync::Arc;

use app::Runtime;
use cli::{Command, Mode, Options};
use error::RuntimeError;

fn main() -> ExitCode {
    let command = match cli::parse(std::env::args().skip(1)) {
        Ok(command) => command,
        Err(e) => return fail(&e),
    };
    match command {
        Command::Help => {
            println!("{}", cli::USAGE);
            ExitCode::SUCCESS
        }
        Command::Run(options) => match run(options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => fail(&e),
        },
    }
}

fn run(options: Options) -> Result<(), RuntimeError> {
    let booted = Runtime::boot(&options)?;
    match options.mode {
        Mode::Repl => repl::run(booted, std::io::stdin().lock(), std::io::stdout().lock()),
        Mode::Serve { port, allow_origins } => {
            server::serve(Arc::new(booted.runtime), port, allow_origins)
        }
    }
}

/// Print an error the one consistent way and pick the exit code.
fn fail(error: &RuntimeError) -> ExitCode {
    eprintln!("{}", error::render(error));
    ExitCode::from(error.exit_code())
}
