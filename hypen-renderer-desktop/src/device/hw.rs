//! Hardware seams of the desktop capture drivers.
//!
//! Every driver reaches a camera, a microphone, a Bluetooth adapter or the
//! OS permission model only through these traits, so the protocol logic is
//! exercised in CI (no camera, no microphone, no adapter, no display) with
//! fake backends; `crate::device::native` holds the real implementations
//! (nokhwa, cpal, btleplug, the platform permission APIs), each behind its
//! cargo feature.
//!
//! Calls may block (opening a camera, an OS permission prompt, a D-Bus
//! round trip): the device host runs them on their own threads, never on
//! the socket worker.

use std::sync::Arc;
use std::time::Duration;

use hypen_engine::serialize::device::DeviceErrorCode;

/// A hardware failure, already classified the way RFC 001 §3 wants it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HwError {
    /// No such hardware right now (no camera, no microphone, no adapter):
    /// `unavailable`, with a fixed detail (`no-camera`, …).
    NoDevice(&'static str),
    /// The OS (or the user, through an OS prompt) refused access: `denied`.
    Denied(String),
    /// The hardware exists but cannot be used now (busy, powered off,
    /// unplugged mid-capture): `unavailable`.
    Unavailable(String),
    /// Anything unexpected: `internal`.
    Internal(String),
}

impl HwError {
    pub fn code(&self) -> DeviceErrorCode {
        match self {
            HwError::NoDevice(_) | HwError::Unavailable(_) => DeviceErrorCode::Unavailable,
            HwError::Denied(_) => DeviceErrorCode::Denied,
            HwError::Internal(_) => DeviceErrorCode::Internal,
        }
    }

    /// Bounded diagnostic text for `platformDetail`.
    pub fn detail(&self) -> String {
        let s = match self {
            HwError::NoDevice(d) => (*d).to_string(),
            HwError::Denied(d) | HwError::Unavailable(d) | HwError::Internal(d) => d.clone(),
        };
        s.chars().take(200).collect()
    }
}

impl std::fmt::Display for HwError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code(), self.detail())
    }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/// `camera.capture`'s `facing` hint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Facing {
    Front,
    Back,
}

/// One camera frame, converted to packed RGB8 (`width * height * 3` bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbFrame {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
    /// Monotonic capture time (any origin): video sample timing.
    pub at: Duration,
}

/// Cameras. `open` may block (and, on macOS, show the OS camera prompt).
pub trait CameraBackend: Send + Sync + 'static {
    /// Cameras attached right now (cheap enumeration).
    fn camera_count(&self) -> Result<usize, HwError>;

    /// Open a camera, preferring `facing` when the platform can tell (a
    /// hint: desktops rarely label their cameras), and start streaming.
    fn open(&self, facing: Option<Facing>) -> Result<Box<dyn CameraSource>, HwError>;
}

/// An open, streaming camera. Dropping it releases the device (the camera
/// light goes off). Opened and used on one thread (the camera thread), so
/// it need not be `Send` (AVFoundation / Media Foundation objects are not).
pub trait CameraSource {
    /// The next frame; blocks for about one frame interval.
    fn next_frame(&mut self) -> Result<RgbFrame, HwError>;
}

// ---------------------------------------------------------------------------
// Microphone
// ---------------------------------------------------------------------------

/// One block of captured audio: interleaved float samples in `-1.0..=1.0`
/// at the device's native rate and channel count.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioBlock {
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

/// Where a microphone delivers audio (called on the audio thread).
pub type AudioSink = Box<dyn FnMut(AudioBlock) + Send>;
/// Where a microphone reports a failure after it started.
pub type AudioErrorSink = Box<dyn FnMut(HwError) + Send>;

/// Microphones.
pub trait MicBackend: Send + Sync + 'static {
    /// A default input device exists right now.
    fn has_input(&self) -> bool;

    /// Start capturing from the default input. Blocks until the stream runs
    /// (or fails). `sink` receives audio until the returned handle drops.
    fn start(
        &self,
        sink: AudioSink,
        on_error: AudioErrorSink,
    ) -> Result<Box<dyn MicStream>, HwError>;
}

/// A running capture; dropping it stops the microphone. No callback runs
/// after the drop returns.
pub trait MicStream: Send {}

// ---------------------------------------------------------------------------
// Bluetooth
// ---------------------------------------------------------------------------

/// One BLE advertisement as the platform reports it. `raw_id` is the
/// platform identifier (a MAC on Linux/Windows, a CoreBluetooth UUID on
/// macOS); the host never sends it — it derives an opaque id from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Advertisement {
    pub raw_id: String,
    pub name: Option<String>,
    pub rssi: i16,
    /// Advertised service UUIDs, canonical lowercase 128-bit form.
    pub services: Vec<String>,
}

/// Scan callbacks (called on the Bluetooth thread).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanEvent {
    Advertisement(Advertisement),
    /// The scan died (adapter removed / powered off / stack error).
    Failed(HwError),
}

pub type ScanSink = Box<dyn FnMut(ScanEvent) + Send>;

/// Bluetooth LE central.
pub trait BluetoothBackend: Send + Sync + 'static {
    /// Check that an adapter exists and is powered on. Blocks (D-Bus /
    /// CoreBluetooth / WinRT round trip). `NoDevice("no-adapter")`,
    /// `Unavailable("adapter-off")`, `Denied("bluetooth")`.
    fn check_adapter(&self) -> Result<(), HwError>;

    /// Start scanning. Advertisements flow to `sink` until the handle drops.
    fn scan(&self, sink: ScanSink) -> Result<Box<dyn ScanHandle>, HwError>;
}

/// A running scan; dropping it stops scanning.
pub trait ScanHandle: Send {}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

pub use hypen_engine::serialize::device::payloads::Permission;

/// What the platform says about one permission, without prompting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionState {
    Granted,
    Denied,
    /// The OS would ask (macOS TCC "not determined").
    Prompt,
    /// The platform cannot represent this permission at all: `unsupported`.
    Unsupported,
    /// The app bundle does not declare the usage description the OS
    /// requires (macOS `NS…UsageDescription`): using the hardware would
    /// terminate the process, so the driver answers `unavailable`
    /// (`not-declared:<name>`).
    NotDeclared,
}

impl PermissionState {
    pub fn wire(&self) -> Option<&'static str> {
        match self {
            PermissionState::Granted => Some("granted"),
            PermissionState::Denied => Some("denied"),
            PermissionState::Prompt => Some("prompt"),
            PermissionState::Unsupported | PermissionState::NotDeclared => None,
        }
    }
}

/// The OS permission model.
pub trait PermissionBackend: Send + Sync + 'static {
    /// Live status; never prompts.
    fn status(&self, permission: Permission) -> PermissionState;

    /// Show the OS prompt (only called for [`PermissionState::Prompt`]).
    /// Blocks until the user answers; returns the resulting state.
    fn request(&self, permission: Permission) -> Result<PermissionState, HwError>;
}

/// The hardware a desktop device host drives. `None` = compiled out / not
/// configured: the capability is not advertised.
#[derive(Clone, Default)]
pub struct Hardware {
    pub camera: Option<Arc<dyn CameraBackend>>,
    pub mic: Option<Arc<dyn MicBackend>>,
    pub bluetooth: Option<Arc<dyn BluetoothBackend>>,
    pub permissions: Option<Arc<dyn PermissionBackend>>,
}

impl std::fmt::Debug for Hardware {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hardware")
            .field("camera", &self.camera.is_some())
            .field("mic", &self.mic.is_some())
            .field("bluetooth", &self.bluetooth.is_some())
            .field("permissions", &self.permissions.is_some())
            .finish()
    }
}

impl Hardware {
    /// The real backends compiled into this build (features `camera`,
    /// `mic`, `bluetooth`) plus the platform permission model.
    pub fn native() -> Self {
        Hardware {
            #[cfg(feature = "camera")]
            camera: Some(Arc::new(super::native::camera::NativeCamera)),
            #[cfg(not(feature = "camera"))]
            camera: None,
            #[cfg(feature = "mic")]
            mic: Some(Arc::new(super::native::mic::NativeMic)),
            #[cfg(not(feature = "mic"))]
            mic: None,
            #[cfg(feature = "bluetooth")]
            bluetooth: Some(Arc::new(super::native::bluetooth::NativeBluetooth)),
            #[cfg(not(feature = "bluetooth"))]
            bluetooth: None,
            permissions: Some(Arc::new(super::native::permissions::NativePermissions)),
        }
    }
}
