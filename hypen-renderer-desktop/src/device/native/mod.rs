//! The real hardware backends of the desktop device host, each behind its
//! cargo feature (`camera`, `mic`, `bluetooth`; all on by default), plus the
//! platform permission model (always compiled).

#[cfg(feature = "bluetooth")]
pub mod bluetooth;
#[cfg(feature = "camera")]
pub mod camera;
#[cfg(feature = "mic")]
pub mod mic;
pub mod permissions;
