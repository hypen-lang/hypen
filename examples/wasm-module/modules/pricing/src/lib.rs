// Pricing — a Hypen module written in Rust and built to a WebAssembly
// Component (`cargo build --release --target wasm32-wasip2`).
//
// It implements the `hypen:module` reducer ABI through wit-bindgen and
// targets the `module-x` world, which adds `hypen:engine/state`: reading,
// subscribing to and dispatching into other modules — each call checked
// against the grants the *host app* gives this module (hypen.json:
// `"reads": ["Cart"], "dispatches": ["Cart"]`). The module itself knows
// nothing about the app around it beyond the name "cart".
//
//   on-activated     subscribe to cart.count -> "recalculate"
//   "recalculate"    read the cart, price it, tell the cart its discount
//   "quote"          the same, on request (the cart's "Ask Pricing" button)
//   "toggleTax"      this module's own button

wit_bindgen::generate!({
    world: "module-x",
    path: "wit",
    generate_all,
});

use hypen::engine::state as engine;
use serde_json::{json, Value};

struct Module;

/// Orders of $50.00 or more get 10% off.
const DISCOUNT_THRESHOLD_CENTS: i64 = 5_000;
const DISCOUNT_PERCENT: i64 = 10;
const TAX_PERCENT: i64 = 8;

fn money(cents: i64) -> String {
    format!("${}.{:02}", cents / 100, cents % 100)
}

fn encode(subtotal: i64, discount: i64, tax_included: bool, quotes: i64) -> Vec<u8> {
    let discounted = subtotal * (100 - discount) / 100;
    let tax = if tax_included { discounted * TAX_PERCENT / 100 } else { 0 };
    json!({
        "subtotalCents": subtotal,
        "discountPercent": discount,
        "taxIncluded": tax_included,
        "quotes": quotes,
        "subtotal": money(subtotal),
        "tax": if tax_included { money(tax) } else { "not included".to_string() },
        "total": money(discounted + tax),
    })
    .to_string()
    .into_bytes()
}

fn output(state: Vec<u8>) -> ReducerOutput {
    ReducerOutput { state: Some(state), effects: vec![], emit: vec![] }
}

/// Read the cart (needs the `reads` grant), price it, and — when the
/// discount the cart shows is not the one it should have — tell it
/// (needs the `dispatches` grant).
fn price_cart(state: &Value, quoted: bool) -> Result<ReducerOutput, String> {
    let bytes = engine::read("cart").map_err(|e| format!("read cart: {e:?}"))?;
    let cart: Value = serde_json::from_slice(&bytes).map_err(|e| format!("cart state: {e}"))?;

    let subtotal: i64 = cart["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item["priceCents"].as_i64().unwrap_or(0) * item["qty"].as_i64().unwrap_or(0))
                .sum()
        })
        .unwrap_or(0);
    let discount = if subtotal >= DISCOUNT_THRESHOLD_CENTS { DISCOUNT_PERCENT } else { 0 };

    if cart["discountPercent"].as_i64().unwrap_or(0) != discount {
        engine::dispatch(
            "cart",
            &engine::Action {
                name: "applyDiscount".into(),
                payload: json!({ "percent": discount }).to_string().into_bytes(),
            },
        )
        .map_err(|e| format!("dispatch cart.applyDiscount: {e:?}"))?;
    }

    let quotes = state["quotes"].as_i64().unwrap_or(0) + i64::from(quoted);
    let tax_included = state["taxIncluded"].as_bool().unwrap_or(false);
    Ok(output(encode(subtotal, discount, tax_included, quotes)))
}

impl Guest for Module {
    fn init(_config: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(encode(0, 0, false, 0))
    }

    fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        let state: Value = serde_json::from_slice(&state).map_err(|e| format!("state: {e}"))?;
        match action.name.as_str() {
            "recalculate" => price_cart(&state, false),
            "quote" => price_cart(&state, true),
            "toggleTax" => Ok(output(encode(
                state["subtotalCents"].as_i64().unwrap_or(0),
                state["discountPercent"].as_i64().unwrap_or(0),
                !state["taxIncluded"].as_bool().unwrap_or(false),
                state["quotes"].as_i64().unwrap_or(0),
            ))),
            other => Err(format!("unknown action: {other}")),
        }
    }

    fn on_activated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        // From now on every change of the cart's item count re-runs
        // "recalculate" here — the total follows the cart with no polling.
        engine::subscribe("cart", "count", "recalculate").map_err(|e| format!("subscribe cart.count: {e:?}"))?;
        Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
    }

    fn on_deactivated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
    }

    fn on_destroyed(_state: Vec<u8>) -> Result<(), String> {
        Ok(())
    }

    fn actions() -> Vec<String> {
        vec!["recalculate".into(), "quote".into(), "toggleTax".into()]
    }
}

export!(Module);
