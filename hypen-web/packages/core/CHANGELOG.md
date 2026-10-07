# Changelog

All notable changes to `@hypen-space/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
