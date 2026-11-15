//! `hypen:http/deferred`: queueing HTTP requests for the engine, and the
//! allowlist hook for blocking `wasi:http`.
//!
//! Like `hypen:engine/state.dispatch`, `send` performs nothing from inside
//! the guest call: it validates the request against the bounds and the
//! module's [`HttpGrant`], queues it, and the queue is handed back in the
//! reducer output. The host never opens a connection for a deferred request —
//! the embedder does, after the engine admitted it.
//!
//! The interface is linked only when the manifest grants `http`
//! (`linker.rs`), so a call here already implies the grant; what is checked
//! per request is the `httpHosts` allowlist.

use std::sync::Arc;

use wasmtime_wasi_http::p2::bindings::http::types::ErrorCode;
use wasmtime_wasi_http::p2::body::HyperOutgoingBody;
use wasmtime_wasi_http::p2::types::{HostFutureIncomingResponse, OutgoingRequestConfig};
use wasmtime_wasi_http::p2::{default_send_request, HttpResult, WasiHttpHooks};

use crate::module_host::{
    HttpGrant, HttpRequestError, HttpScheme, QueuedHttpRequest, ReducerOutput,
    MAX_HTTP_REQUESTS_PER_CALL,
};

/// Per-store deferred-HTTP state. `Active` only while an export that returns
/// a reducer output runs (`dispatch`, `on-activated`, `on-deactivated`);
/// outside one (`init`, `on-destroyed`, `actions`, component start) there is
/// no output to carry a request, so `send` is refused.
#[derive(Debug, Default)]
pub(crate) enum DeferredHttpCtx {
    #[default]
    Idle,
    Active {
        grant: Arc<HttpGrant>,
        queued: Vec<QueuedHttpRequest>,
    },
}

impl DeferredHttpCtx {
    pub(crate) fn begin(&mut self, grant: Arc<HttpGrant>) {
        *self = Self::Active {
            grant,
            queued: Vec::new(),
        };
    }

    /// Leave the call, returning what it queued. Always resets to `Idle`.
    pub(crate) fn end(&mut self) -> Queued {
        match std::mem::take(self) {
            Self::Active { queued, .. } => Queued(queued),
            Self::Idle => Queued(Vec::new()),
        }
    }

    /// Validate and queue one request.
    pub(crate) fn send(&mut self, request: QueuedHttpRequest) -> Result<(), HttpRequestError> {
        let Self::Active { grant, queued } = self else {
            return Err(HttpRequestError::PermissionDenied(
                "http: requests can only be queued from `dispatch`, `on-activated` or \
                 `on-deactivated` (this export returns no reducer output to carry one)"
                    .into(),
            ));
        };
        let url = request.validate()?;
        grant
            .check(&url)
            .map_err(|denial| HttpRequestError::PermissionDenied(denial.to_string()))?;
        if queued.len() >= MAX_HTTP_REQUESTS_PER_CALL {
            return Err(HttpRequestError::LimitExceeded(format!(
                "too many requests in one call (limit {MAX_HTTP_REQUESTS_PER_CALL})"
            )));
        }
        queued.push(request);
        Ok(())
    }
}

/// The requests one guest call queued.
pub(crate) struct Queued(Vec<QueuedHttpRequest>);

impl Queued {
    pub(crate) fn attach_to(self, output: &mut ReducerOutput) {
        output.http_requests = self.0;
    }
}

/// `wasi:http` hooks that apply the module's `httpHosts` allowlist to every
/// blocking request before it is sent.
///
/// `wasmtime-wasi-http` routes each `outgoing-handler.handle` through
/// [`WasiHttpHooks::send_request`] with the final URI, and its default sender
/// follows no redirects (the guest's own client issues each hop as a new
/// request, which comes through here again) — so this one check covers every
/// connection a module can open through `wasi:http`.
pub(crate) struct AllowlistHooks {
    grant: Arc<HttpGrant>,
}

impl AllowlistHooks {
    pub(crate) fn new(grant: Arc<HttpGrant>) -> Self {
        Self { grant }
    }
}

impl WasiHttpHooks for AllowlistHooks {
    fn send_request(
        &mut self,
        request: http::Request<HyperOutgoingBody>,
        config: OutgoingRequestConfig,
    ) -> HttpResult<HostFutureIncomingResponse> {
        let scheme = if config.use_tls {
            HttpScheme::Https
        } else {
            HttpScheme::Http
        };
        let uri = request.uri();
        let port = uri.port_u16().unwrap_or(scheme.default_port());
        let allowed = uri
            .host()
            .is_some_and(|host| self.grant.check_authority(host, port).is_ok());
        if !allowed {
            return Err(ErrorCode::HttpRequestDenied.into());
        }
        Ok(default_send_request(request, config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module_host::HttpRequest;

    fn request(url: &str) -> QueuedHttpRequest {
        QueuedHttpRequest {
            request: HttpRequest {
                method: "GET".into(),
                url: url.into(),
                headers: Vec::new(),
                body: None,
                timeout_ms: None,
            },
            then: "done".into(),
            tag: None,
        }
    }

    #[test]
    fn nothing_can_be_queued_outside_a_reducer_call() {
        let mut ctx = DeferredHttpCtx::default();
        let Err(HttpRequestError::PermissionDenied(why)) = ctx.send(request("http://h/")) else {
            panic!("queued outside a call")
        };
        assert!(why.contains("can only be queued from"), "{why}");
        let mut output = ReducerOutput::default();
        ctx.end().attach_to(&mut output);
        assert!(output.http_requests.is_empty());
    }

    #[test]
    fn requests_are_validated_allowlisted_and_bounded() {
        let mut ctx = DeferredHttpCtx::default();
        let hosts = HttpGrant::Hosts(vec!["*.example.com".parse().unwrap()]);
        ctx.begin(Arc::new(hosts));

        assert!(matches!(
            ctx.send(request("not a url")),
            Err(HttpRequestError::InvalidRequest(_))
        ));
        let Err(HttpRequestError::PermissionDenied(why)) = ctx.send(request("https://evil.test/"))
        else {
            panic!("allowlist not applied")
        };
        assert!(why.contains("'evil.test:443'") && why.contains("httpHosts"), "{why}");

        for _ in 0..MAX_HTTP_REQUESTS_PER_CALL {
            ctx.send(request("https://api.example.com/")).unwrap();
        }
        let Err(HttpRequestError::LimitExceeded(why)) = ctx.send(request("https://api.example.com/"))
        else {
            panic!("count bound not applied")
        };
        assert!(why.contains("too many requests"), "{why}");

        let mut output = ReducerOutput::default();
        ctx.end().attach_to(&mut output);
        assert_eq!(output.http_requests.len(), MAX_HTTP_REQUESTS_PER_CALL);
        // The window closed with the call.
        assert!(ctx.send(request("https://api.example.com/")).is_err());
    }
}
