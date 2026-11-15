# Changelog

All notable changes to `@hypen-space/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Hosted modules — modules whose logic is a prebuilt WebAssembly Component, defined with
  `wasmModule()` in `@hypen-space/server` — are first-class module definitions. New
  `hosted-module.ts` (also `@hypen-space/core/hosted-module`): `HostedModuleDefinition`,
  `isHostedModuleDefinition`, `HostedModuleInstance`, `AnyModuleInstance` (discriminated by
  `kind`), `HostedModuleFailure`, and the `SessionHost.hostedModules` provider seam
  (`HostedModuleProvider` / `HostedModuleSession`). `HypenModuleDefinition` gains the optional
  `hosted` field; `HypenModuleInstance` gains `kind: "inProcess"`. Core stays WASM-free and
  nothing changes for apps without hosted modules.
- `ModuleReference` (`context.getModule(id)`) gains `kind` and `dispatch(action, payload?)`:
  dispatch an action to another module from app code. Works for TypeScript modules (runs the
  module's `onAction` handler) and hosted ones; always deferred, so it is safe inside a handler.
  For a hosted module `state` is a frozen snapshot and `setState` throws.
- `HypenModuleInstance.dispatch(name, payload?, sender?)`.
- `ManagedRouter` mounts hosted route modules through the new `createHostedInstance` option and
  drives them like in-process ones (activate / deactivate / persist cache / LRU eviction /
  `persist: false`). `getActiveInstance()` returns the active module of either kind;
  `getActiveModule()` and `liveInstances()` keep returning in-process instances only.
- `RemoteSession`: opens the host's hosted-module session after the handshake, mounts hosted child
  and route modules, re-instantiates crashed instances before the next client action, and reports
  a failing hosted action through the provider instead of failing the message. `session.hostedModules`.

### Fixed
- `BaseEngine.dispatchAction` no longer flattens a `HostedModuleError` (a routed action that
  failed inside a hosted module) into a generic `HypenError`: the error keeps its `code` and
  cascade `report`.

### Security
- `RemoteSession` no longer passes a client's `dispatchAction` message to the engine verbatim.
  A client action now runs only as a `__hypen_dispatch` envelope addressed to a live node that
  declares it (what the DOM, Canvas and native renderers send for every UI event). Refused, with
  a warning and no handler call: a pre-scoped `__hypen_scoped:<scope>:<name>`, a bare reserved
  write (`__hypen_bind` / `__hypen_reorder` / `__hypen_pin` — previously an arbitrary state-path
  write in a single-module app), and a bare application name. With an engine artifact that has
  `resolveClientAction`, an envelope must also address the node that carries the binding, not
  just any node of the owning module.
  **Breaking for clients that dispatch by bare name** (`RemoteEngine.dispatchAction("x")` from
  app code, `navigation.backAction`): list those names with
  `RemoteServer.allowUnboundClientActions([...])` / `SessionHost.unboundClientActions` / the CF
  `unboundClientActions` option (`"any"` restores the old behaviour for application names).
  `router.push|replace|back|forward` stay accepted by name. New: `BaseEngine.resolveClientAction`,
  `BaseEngine.hasClientActionEntry`, `remote/client-action.ts`.

### Fixed
- `RemoteSession`: named child modules mounted directly in a template
  (`module App { Column { Counter() } }`, or a second module inside one `Route`)
  now get a session-lifetime module instance, so their actions run instead of
  failing with "invalid scoped UI action". Route components stay owned by the
  auto-wired `ManagedRouter`.
- `RemoteSession`: a stateful child template without its own `module Name { }`
  wrapper (the single-file `app.defineState(...).ui(hypen...)` form) is
  scoped to its component name, so `@{state.*}` and `@actions.*` resolve to it.
- The browser entry (`index.browser`) now exports `hypen`, `state`, `item` and
  `index`, so single-file components bundle under `hypen build`.

### Changed
- Device Capability Protocol (RFC 001, unreleased): the device plane is on by default on every
  server host — `SessionHost.deviceEnabled` is replaced by the opt-out `deviceDisabled`. Legacy
  clients keep the 1 s hello grace; every `sessionAck` carries a `resumeToken`, required only to
  resume a session that negotiated a device plane (`SessionManager.markDeviceSession` /
  `requiresResumeToken`).
- Device plane and compression (RFC 001 §2.3, unreleased): `RemoteEngine` keeps its device plane
  on a compressed socket when the negotiated permessage-deflate carries both
  `server_no_context_takeover` and `client_no_context_takeover` (each message compressed on its
  own); context takeover in either direction still keeps the connection UI-only (hello omits
  `device`, one warning). New `deflateContextPolicy` / `deviceSafeExtensions` /
  `parseWebSocketExtensions` in `@hypen-space/core/remote`.
- `syncActions` no longer disables the device plane in `RemoteSession`: a replayed dispatch runs
  with replay provenance and its `context.device` refuses (`unavailable`, `syncActions.replay`);
  only the originating client can start device work. `allow-multiple` still refuses it.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the platform-agnostic core runtime
