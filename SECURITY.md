# Security policy

## Supported versions

Hypen is pre-1.0. Security fixes land on the latest minor release only; every SDK and renderer ships in lockstep, so upgrade all `@hypen-space/*` packages and crates together.

## Reporting a vulnerability

Please do not open a public issue for security problems.

- Preferred: use GitHub's private vulnerability reporting on this repository ("Security" tab, then "Report a vulnerability").
- Or email ian@hypen.space.

Include the affected package and version, a reproduction, and the impact you see. You will get an acknowledgement within three working days and a fix or a mitigation plan as soon as we have one. We will credit you in the release notes unless you ask us not to.

## Scope notes

Hypen apps keep state and logic on the server and stream UI patches to clients. Reports about the patch protocol, the device capability plane (admission, limits, uploads), or the agent interface (`@hypen-space/agent`) are especially welcome, since those are the trust boundaries.
