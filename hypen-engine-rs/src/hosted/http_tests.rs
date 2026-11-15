//! Deferred HTTP driven through the subsystem: what is admitted and handed
//! to the embedder, what is refused (and how the module and the report learn
//! of it), and what a completion delivers.

use super::*;
use crate::module_host::{
    HostPattern, HttpEffect, HttpFailure, HttpFailureKind, HttpGrant, HttpOutcome, HttpRequest,
    HttpRequestId, HttpResponse, HttpUrl, QueuedHttpRequest, MAX_HTTP_REQUESTS_PER_CALL,
};

fn request(url: &str, then: &str, tag: Option<&str>) -> QueuedHttpRequest {
    QueuedHttpRequest {
        request: HttpRequest {
            method: "GET".into(),
            url: url.into(),
            headers: Vec::new(),
            body: None,
            timeout_ms: None,
        },
        then: then.into(),
        tag: tag.map(str::to_string),
    }
}

fn queue(requests: Vec<QueuedHttpRequest>) -> ReducerOutput {
    ReducerOutput {
        http_requests: requests,
        ..Default::default()
    }
}

fn any_host() -> ModuleGrants {
    ModuleGrants::none().with_http(HttpGrant::AnyHost)
}

fn hosts(patterns: &[&str]) -> ModuleGrants {
    let patterns: Vec<HostPattern> = patterns.iter().map(|p| p.parse().unwrap()).collect();
    ModuleGrants::none().with_http(HttpGrant::Hosts(patterns))
}

fn ok(status: u16, headers: &[(&str, &str)], body: &[u8]) -> HttpOutcome {
    HttpOutcome::Response(HttpResponse {
        status,
        headers: headers
            .iter()
            .map(|(n, v)| (n.to_string(), v.to_string()))
            .collect(),
        body: body.to_vec(),
    })
}

/// The requests the engine handed to the embedder.
type Outbox = Arc<Mutex<Vec<(String, HttpEffect)>>>;

impl Fixture {
    /// Install an effect handler that records `Effect::Http`.
    fn embedder(&mut self) -> Outbox {
        let outbox: Outbox = Arc::default();
        let sink = Arc::clone(&outbox);
        self.hosted
            .set_effect_handler(Box::new(move |scope, effect| {
                if let crate::module_host::Effect::Http(http) = effect {
                    sink.lock().unwrap().push((scope.to_string(), http.clone()));
                }
            }));
        outbox
    }

    fn complete(
        &mut self,
        id: HttpRequestId,
        outcome: HttpOutcome,
    ) -> Result<HttpDelivery, HttpCompletionError> {
        let (hosted, mut ctx) = self.parts();
        hosted.complete_http(&mut ctx, id, outcome)
    }

    /// The payload the last call of `action` received, as JSON.
    fn payload_of(&self, action: &str) -> Value {
        let script = self.script.lock().unwrap();
        let seen = script
            .seen
            .iter()
            .rev()
            .find(|s| s.action == action)
            .unwrap_or_else(|| panic!("'{action}' never ran"));
        serde_json::from_str(&seen.payload).unwrap()
    }

    fn ran(&self, action: &str) -> usize {
        let script = self.script.lock().unwrap();
        script.seen.iter().filter(|s| s.action == action).count()
    }
}

/// A module `m` with actions `go` (queues `requests`) and `done`.
fn fetcher(fx: &mut Fixture, grants: ModuleGrants, requests: Vec<QueuedHttpRequest>) -> u64 {
    fx.module("m", &["go", "done"], grants, move |seen| {
        Ok(match seen.action.as_str() {
            "go" => ReducerOutput {
                state: Some(br#"{"asked":true}"#.to_vec()),
                ..queue(requests.clone())
            },
            _ => ReducerOutput::default(),
        })
    })
}

#[test]
fn an_admitted_request_reaches_the_embedder_and_its_completion_runs_then() {
    let mut fx = Fixture::new();
    let outbox = fx.embedder();
    let mut post = request("https://API.example.com/v1?q=1", "done", Some("t-1"));
    post.request.method = "POST".into();
    post.request.headers = vec![("Content-Type".into(), "application/json".into())];
    post.request.body = Some(b"{}".to_vec());
    post.request.timeout_ms = Some(500);
    fetcher(&mut fx, hosts(&["*.example.com"]), vec![post.clone()]);

    fx.dispatch("m", "go").unwrap();
    assert_eq!(fx.state("m"), json!({ "asked": true }));
    assert_eq!(fx.ran("done"), 0, "nothing completes synchronously");

    let (scope, effect) = outbox.lock().unwrap().pop().expect("handed to the embedder");
    assert_eq!(scope, "m");
    assert_eq!(effect.request, post.request, "the request is passed on unchanged");
    assert_eq!(
        (effect.url.host(), effect.url.port(), effect.url.path_and_query()),
        ("api.example.com", 443, "/v1?q=1")
    );
    assert_eq!((effect.then.as_str(), effect.tag.as_deref()), ("done", Some("t-1")));
    // The grant travels with the effect, for redirect hops.
    assert!(effect.grant.check(&HttpUrl::parse("https://cdn.example.com/").unwrap()).is_ok());
    assert!(effect.grant.check(&HttpUrl::parse("https://evil.test/").unwrap()).is_err());
    let elsewhere = HttpUrl::parse("https://evil.test/").unwrap();
    assert!(matches!(fx.hosted.http_redirect_check(effect.id, &elsewhere), Some(Err(_))));
    assert_eq!(fx.hosted.http_in_flight("M"), 1);

    let outcome = ok(
        200,
        &[("Content-Type", "text/plain"), ("X-A", "1"), ("x-a", "2")],
        b"hello",
    );
    assert_eq!(fx.complete(effect.id, outcome), Ok(HttpDelivery::Delivered));
    assert_eq!(
        fx.payload_of("done"),
        json!({
            "ok": true,
            "status": 200,
            "headers": { "content-type": "text/plain", "x-a": "1, 2" },
            "body": "hello",
            "bodyEncoding": "utf8",
            "tag": "t-1",
        })
    );
    assert_eq!(fx.hosted.http_in_flight("m"), 0, "the slot is released");
    assert!(fx.hosted.http_redirect_check(effect.id, &elsewhere).is_none());

    // A second completion of the same request is an error, and runs nothing.
    assert_eq!(
        fx.complete(effect.id, ok(200, &[], b"again")),
        Err(HttpCompletionError::UnknownRequest(effect.id))
    );
    assert_eq!(fx.ran("done"), 1);
    let e = fx.complete(HttpRequestId(9_999), ok(200, &[], b"")).unwrap_err();
    assert!(e.to_string().contains("no HTTP request is in flight under id 9999"), "{e}");
}

#[test]
fn completions_deliver_the_documented_payload_for_every_outcome() {
    let mut fx = Fixture::new();
    let outbox = fx.embedder();
    fetcher(&mut fx, any_host(), vec![request("http://h/", "done", None)]);
    let complete = |fx: &mut Fixture, outcome: HttpOutcome| {
        fx.dispatch("m", "go").unwrap();
        let (_, effect) = outbox.lock().unwrap().pop().unwrap();
        assert_eq!(fx.complete(effect.id, outcome), Ok(HttpDelivery::Delivered));
        fx.payload_of("done")
    };

    // Binary body → base64.
    assert_eq!(
        complete(&mut fx, ok(200, &[], &[0x00, 0xff, 0x10])),
        json!({ "ok": true, "status": 200, "headers": {}, "body": "AP8Q",
                "bodyEncoding": "base64", "tag": null })
    );
    // A non-2xx status is a completed exchange.
    assert_eq!(
        complete(&mut fx, ok(404, &[("Content-Length", "9")], b"not found")),
        json!({ "ok": true, "status": 404, "headers": { "content-length": "9" },
                "body": "not found", "bodyEncoding": "utf8", "tag": null })
    );
    assert_eq!(complete(&mut fx, ok(500, &[], b""))["status"], 500);

    for (kind, wire) in [
        (HttpFailureKind::Network, "network"),
        (HttpFailureKind::Timeout, "timeout"),
        (HttpFailureKind::Denied, "denied"),
        (HttpFailureKind::TooLarge, "too-large"),
        (HttpFailureKind::InvalidResponse, "invalid-response"),
    ] {
        let failure = HttpOutcome::Failure(HttpFailure::new(kind, "because"));
        assert_eq!(
            complete(&mut fx, failure),
            json!({ "ok": false, "error": { "kind": wire, "message": "because" }, "tag": null })
        );
    }
    // The engine enforces the response cap whatever the embedder read.
    let huge = ok(200, &[], &vec![b'x'; crate::module_host::MAX_HTTP_RESPONSE_BODY_BYTES + 1]);
    assert_eq!(complete(&mut fx, huge)["error"]["kind"], "too-large");
}

/// Dispatch `go` on a module that queues `queued` under `grants` and return
/// the single failure's JSON, plus what the module was told.
fn refused(grants: ModuleGrants, queued: QueuedHttpRequest) -> (Value, Option<Value>, String) {
    let mut fx = Fixture::new();
    let outbox = fx.embedder();
    fetcher(&mut fx, grants, vec![queued]);
    let message = message(fx.dispatch("m", "go"));
    assert!(outbox.lock().unwrap().is_empty(), "a refused request reached the embedder");
    assert_eq!(fx.state("m"), json!({ "asked": true }), "the dispatch itself stands");
    assert_eq!(fx.hosted.http_in_flight("m"), 0);
    let report = fx.report();
    assert_eq!(report.failure_count(), 1, "{message}");
    let failure = report.failures()[0].to_json();
    let told = (fx.ran("done") > 0).then(|| fx.payload_of("done"));
    (failure, told, message)
}

#[test]
fn a_request_without_the_grant_or_outside_the_allowlist_is_refused_and_completed_as_denied() {
    let (failure, told, message) =
        refused(ModuleGrants::none(), request("https://api.example.com/", "done", Some("t")));
    assert_eq!(failure["cause"], json!({ "code": "httpNotGranted", "grant": "http" }));
    assert_eq!(failure["outcome"], "refused");
    assert_eq!(
        failure["origin"],
        json!({ "kind": "httpRequest", "method": "GET", "url": "https://api.example.com/" })
    );
    assert_eq!(failure["action"], "done");
    assert!(
        message.contains("[m] http request GET https://api.example.com/ refused")
            && message.contains("set `http: true`"),
        "{message}"
    );
    assert_eq!(
        told.unwrap(),
        json!({ "ok": false,
                "error": { "kind": "denied", "message": "the module's manifest does not grant `http`" },
                "tag": "t" })
    );

    let allow = &["api.example.com:8443", "*.cdn.example.com", "localhost"];
    for (url, host) in [
        ("https://evil.test/", "evil.test:443"),
        // The exact host, on another port than the pattern's.
        ("https://api.example.com/", "api.example.com:443"),
        // The wildcard covers subdomains, not the apex or look-alikes.
        ("https://cdn.example.com/", "cdn.example.com:443"),
        ("https://xcdn.example.com/a", "xcdn.example.com:443"),
        ("http://localhost.evil.test/", "localhost.evil.test:80"),
    ] {
        let (failure, told, message) = refused(hosts(allow), request(url, "done", None));
        assert_eq!(
            failure["cause"],
            json!({ "code": "httpDenied", "grant": "httpHosts", "host": host }),
            "{url}"
        );
        assert!(message.contains(&format!("host '{host}' is not in the `httpHosts` allowlist")));
        let told = told.unwrap();
        assert_eq!(told["error"]["kind"], "denied");
        assert!(told["error"]["message"].as_str().unwrap().contains(host), "{told}");
    }
}

#[test]
fn the_allowlist_admits_matching_hosts_ports_and_both_schemes() {
    let allow = &["api.example.com:8443", "*.cdn.example.com", "localhost", "[::1]:9"];
    for url in [
        "https://api.example.com:8443/x",
        "http://API.EXAMPLE.COM:8443",
        "https://a.cdn.example.com/",
        "http://a.b.cdn.example.com:81/",
        "http://localhost:3000/",
        "https://localhost/",
        "http://[0:0:0:0:0:0:0:1]:9/",
    ] {
        let mut fx = Fixture::new();
        let outbox = fx.embedder();
        fetcher(&mut fx, hosts(allow), vec![request(url, "done", None)]);
        fx.dispatch("m", "go").unwrap_or_else(|e| panic!("{url}: {e}"));
        assert_eq!(outbox.lock().unwrap().len(), 1, "{url}");
    }
}

#[test]
fn malformed_requests_are_refused_whatever_the_host_let_through() {
    for (url, hint) in [
        ("ftp://example.com/", "http:// or https://"),
        ("example.com", "http:// or https://"),
        ("https://user:pw@example.com/", "credentials"),
        ("http://2130706433/", "dotted quad"),
    ] {
        let (failure, told, _) = refused(any_host(), request(url, "done", None));
        assert_eq!(failure["cause"]["code"], "httpInvalid", "{url}");
        assert!(failure["cause"]["detail"].as_str().unwrap().contains(hint), "{failure}");
        assert_eq!(told.unwrap()["error"]["kind"], "denied");
    }
    let mut smuggling = request("http://h/", "done", None);
    smuggling.request.headers = vec![("Host".into(), "evil.test".into())];
    let (failure, _, _) = refused(any_host(), smuggling);
    assert!(failure["cause"]["detail"].as_str().unwrap().contains("set by the host"), "{failure}");
}

#[test]
fn a_then_the_module_does_not_accept_is_refused_and_nothing_is_delivered() {
    let (failure, told, message) = refused(any_host(), request("http://h/", "nope", None));
    assert_eq!(failure["cause"], json!({ "code": "notAccepted" }));
    assert_eq!(failure["action"], "nope");
    assert!(message.contains("`then` 'nope' is not an action of 'm'"), "{message}");
    assert_eq!(told, None);
}

#[test]
fn requests_past_the_per_call_bound_are_dropped() {
    let mut fx = Fixture::new();
    let outbox = fx.embedder();
    fx.hosted.set_http_in_flight_limit(1_000);
    let many = vec![request("http://h/", "done", None); MAX_HTTP_REQUESTS_PER_CALL + 3];
    fetcher(&mut fx, any_host(), many);
    let message = message(fx.dispatch("m", "go"));
    assert_eq!(outbox.lock().unwrap().len(), MAX_HTTP_REQUESTS_PER_CALL);
    assert_eq!(fx.report().failure_count(), 3, "{message}");
    assert_eq!(
        fx.report().failures()[0].to_json()["cause"],
        json!({ "code": "httpLimit", "limit": MAX_HTTP_REQUESTS_PER_CALL, "per": "call" })
    );
    assert_eq!(fx.report().failures()[0].to_json()["outcome"], "dropped");
    assert_eq!(fx.ran("done"), 3, "each dropped request is completed as denied");
}

#[test]
fn the_in_flight_cap_is_per_module_and_a_completion_frees_a_slot() {
    let mut fx = Fixture::new();
    let outbox = fx.embedder();
    assert_eq!(fx.hosted.http_in_flight_limit(), 32);
    fx.hosted.set_http_in_flight_limit(2);
    fetcher(&mut fx, any_host(), vec![request("http://h/", "done", Some("x"))]);
    fx.module("other", &["go", "done"], any_host(), |seen| {
        Ok(match seen.action.as_str() {
            "go" => queue(vec![request("http://h/", "done", None)]),
            _ => ReducerOutput::default(),
        })
    });

    fx.dispatch("m", "go").unwrap();
    fx.dispatch("m", "go").unwrap();
    let message = message(fx.dispatch("m", "go"));
    assert_eq!(
        fx.report().failures()[0].to_json()["cause"],
        json!({ "code": "httpLimit", "limit": 2, "per": "module" })
    );
    assert!(message.contains("too many requests in flight (limit 2)"), "{message}");
    assert_eq!(fx.payload_of("done")["error"]["kind"], "denied");
    assert_eq!(fx.payload_of("done")["tag"], "x");
    assert_eq!((outbox.lock().unwrap().len(), fx.hosted.http_in_flight("m")), (2, 2));

    // Another module has its own budget.
    fx.dispatch("other", "go").unwrap();
    assert_eq!(fx.hosted.http_in_flight("other"), 1);

    // Completing one of m's frees one slot.
    let id = outbox.lock().unwrap()[0].1.id;
    fx.complete(id, ok(204, &[], b"")).unwrap();
    assert_eq!(fx.hosted.http_in_flight("m"), 1);
    fx.dispatch("m", "go").unwrap();
    assert_eq!(fx.hosted.http_in_flight("m"), 2);
}

#[test]
fn without_an_effect_handler_requests_are_refused_not_lost() {
    let mut fx = Fixture::new();
    fetcher(&mut fx, any_host(), vec![request("http://h/", "done", None)]);
    let message = message(fx.dispatch("m", "go"));
    assert_eq!(fx.report().failures()[0].to_json()["cause"], json!({ "code": "httpUnavailable" }));
    assert!(message.contains("no effect handler installed"), "{message}");
    assert_eq!(fx.payload_of("done")["error"]["kind"], "denied");
    assert_eq!(fx.hosted.http_in_flight("m"), 0);
}

#[test]
fn a_completion_handler_can_queue_the_next_request() {
    let mut fx = Fixture::new();
    let outbox = fx.embedder();
    fx.module("m", &["go", "done"], any_host(), |seen| {
        Ok(match seen.action.as_str() {
            "go" => queue(vec![request("http://h/1", "done", Some("first"))]),
            "done" if seen.payload.contains("\"first\"") => {
                queue(vec![request("http://h/2", "done", Some("second"))])
            }
            _ => with_state(json!({ "finished": true })),
        })
    });
    fx.dispatch("m", "go").unwrap();
    let (_, first) = outbox.lock().unwrap().pop().unwrap();
    fx.complete(first.id, ok(200, &[], b"1")).unwrap();
    let (_, second) = outbox.lock().unwrap().pop().expect("chained from the completion");
    assert_eq!(second.request.url, "http://h/2");
    assert_ne!(second.id, first.id);
    fx.complete(second.id, ok(200, &[], b"2")).unwrap();
    assert_eq!(fx.state("m"), json!({ "finished": true }));
    assert!(outbox.lock().unwrap().is_empty());
}

#[test]
fn completions_for_a_destroyed_or_reloaded_module_are_dropped_and_free_their_slots() {
    let mut fx = Fixture::new();
    let outbox = fx.embedder();
    fx.hosted.set_http_in_flight_limit(1);
    fetcher(&mut fx, any_host(), vec![request("http://h/", "done", None)]);

    // Reload: a new instance takes over the scope, state kept.
    fx.dispatch("m", "go").unwrap();
    let (_, before_reload) = outbox.lock().unwrap().pop().unwrap();
    {
        let (hosted, mut ctx) = fx.parts();
        let actions = vec!["go".to_string(), "done".to_string()];
        hosted
            .rewire(&mut ctx, "m", ModuleInstanceId(0), actions, any_host())
            .unwrap();
    }
    assert_eq!(fx.hosted.http_in_flight("m"), 0, "the new instance starts with a free budget");
    fx.dispatch("m", "go").unwrap();
    let (_, after_reload) = outbox.lock().unwrap().pop().unwrap();

    assert_eq!(fx.complete(before_reload.id, ok(200, &[], b"old")), Ok(HttpDelivery::ModuleGone));
    assert_eq!(fx.ran("done"), 0, "the old instance's response reached the new one");
    assert_eq!(fx.complete(before_reload.id, ok(200, &[], b"old")).unwrap_err(),
        HttpCompletionError::UnknownRequest(before_reload.id));
    assert_eq!(fx.complete(after_reload.id, ok(200, &[], b"new")), Ok(HttpDelivery::Delivered));
    assert_eq!(fx.payload_of("done")["body"], "new");

    // Destroy: nothing left to deliver to; no panic, no error.
    fx.dispatch("m", "go").unwrap();
    let (_, pending) = outbox.lock().unwrap().pop().unwrap();
    fx.destroy("m").unwrap();
    let calls = fx.ran("done");
    assert_eq!(fx.complete(pending.id, ok(200, &[], b"late")), Ok(HttpDelivery::ModuleGone));
    assert_eq!(fx.ran("done"), calls);

    // A new module registered under the same scope is a different wiring.
    fx.dispatch("m", "go").unwrap_err();
    fetcher(&mut fx, any_host(), vec![request("http://h/", "done", None)]);
    assert_eq!(fx.hosted.http_in_flight("m"), 0);
}

#[test]
fn a_failing_completion_handler_is_reported_through_the_cascade_report() {
    let mut fx = Fixture::new();
    let outbox = fx.embedder();
    fx.module("m", &["go", "done"], any_host(), |seen| match seen.action.as_str() {
        "go" => Ok(queue(vec![request("http://h/", "done", None)])),
        _ => Err(HostError::ModuleError("cannot parse the response".into())),
    });
    fx.dispatch("m", "go").unwrap();
    let (_, effect) = outbox.lock().unwrap().pop().unwrap();
    let Err(HttpCompletionError::Cascade(EngineError::ModuleError(why))) =
        fx.complete(effect.id, ok(200, &[], b"x"))
    else {
        panic!("the handler's failure was swallowed")
    };
    assert!(why.contains("[m] 'done' failed") && why.contains("cannot parse the response"), "{why}");
    let failure = &fx.report().failures()[0];
    assert!(failure.is_root());
    assert_eq!(fx.hosted.http_in_flight("m"), 0, "the request is complete all the same");
}

#[test]
fn an_http_effect_returned_by_a_reducer_is_ignored() {
    let mut fx = Fixture::new();
    let outbox = fx.embedder();
    fx.module("m", &["go"], any_host(), |_| {
        let forged = HttpEffect {
            id: HttpRequestId(7),
            request: request("http://h/", "go", None).request,
            url: HttpUrl::parse("http://h/").unwrap(),
            grant: Arc::new(HttpGrant::AnyHost),
            then: "go".into(),
            tag: None,
        };
        Ok(ReducerOutput {
            effects: vec![crate::module_host::Effect::Http(forged)],
            ..Default::default()
        })
    });
    fx.dispatch("m", "go").unwrap();
    assert!(outbox.lock().unwrap().is_empty());
    assert!(fx.complete(HttpRequestId(7), ok(200, &[], b"")).is_err());
}
