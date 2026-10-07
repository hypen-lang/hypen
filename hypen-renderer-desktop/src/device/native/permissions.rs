//! The desktop OS permission model behind `permission.query` /
//! `permission.request`, reported as honestly as each platform allows
//! (RFC 001 §3: permission status is distinct from capability support and
//! from the host's own per-use consent).
//!
//! | Permission | macOS | Windows | Linux |
//! |---|---|---|---|
//! | `camera` | TCC (`AVCaptureDevice` authorization); `not-declared` without `NSCameraUsageDescription` in a bundle | the Privacy › Camera switches (ConsentStore `webcam`): `denied` when off, else `granted` | no per-app model: `denied` only when every `/dev/video*` node refuses this user, else `granted` |
//! | `microphone` | TCC (`AVCaptureDevice`, audio); `NSMicrophoneUsageDescription` | Privacy › Microphone (ConsentStore `microphone`) | no per-app model: `granted` |
//! | `bluetooth` | `CBManager.authorization`; `NSBluetoothAlwaysUsageDescription` | no per-app gate for desktop apps: `granted` | BlueZ admits the session user: `granted` |
//! | `photos` | `granted` (the file dialog needs no permission) | `granted` | `granted` |
//! | `location`, `notifications`, `contacts` | `unsupported` (no desktop driver) | `unsupported` | `unsupported` |
//!
//! Only macOS can answer `prompt`, and only there does
//! `permission.request` show an OS prompt.

use crate::device::hw::{HwError, Permission, PermissionBackend, PermissionState};

/// The platform permission model.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativePermissions;

impl PermissionBackend for NativePermissions {
    fn status(&self, permission: Permission) -> PermissionState {
        match permission {
            Permission::Photos => PermissionState::Granted,
            Permission::Location | Permission::Notifications | Permission::Contacts => {
                PermissionState::Unsupported
            }
            Permission::Camera | Permission::Microphone | Permission::Bluetooth => {
                platform::status(permission)
            }
        }
    }

    fn request(&self, permission: Permission) -> Result<PermissionState, HwError> {
        match self.status(permission) {
            PermissionState::Prompt => platform::request(permission),
            other => Ok(other),
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    /// Linux has no per-app camera permission: access is the device node's
    /// file permission (usually the `video` group or a logind ACL).
    pub fn status(p: Permission) -> PermissionState {
        match p {
            Permission::Camera => camera_nodes(std::path::Path::new("/dev")),
            _ => PermissionState::Granted,
        }
    }

    pub fn camera_nodes(dev: &std::path::Path) -> PermissionState {
        let Ok(entries) = std::fs::read_dir(dev) else {
            return PermissionState::Granted;
        };
        let mut any = false;
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with("video") {
                continue;
            }
            any = true;
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(entry.path())
            {
                Ok(_) => return PermissionState::Granted,
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {}
                Err(_) => return PermissionState::Granted, // busy etc.: not a permission problem
            }
        }
        if any {
            PermissionState::Denied
        } else {
            PermissionState::Granted
        }
    }

    pub fn request(p: Permission) -> Result<PermissionState, HwError> {
        Ok(status(p))
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    /// The Settings › Privacy switches live in the capability ConsentStore:
    /// the machine-wide value, the per-user value, and the per-user value
    /// for desktop (non-packaged) apps. Any `Deny` means Windows will
    /// refuse this app.
    pub fn status(p: Permission) -> PermissionState {
        let store = match p {
            Permission::Camera => "webcam",
            Permission::Microphone => "microphone",
            _ => return PermissionState::Granted,
        };
        let base = format!(
            r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{store}"
        );
        let keys = [
            format!(r"HKLM\{base}"),
            format!(r"HKCU\{base}"),
            format!(r"HKCU\{base}\NonPackaged"),
        ];
        if keys.iter().any(|k| reg_value(k).as_deref() == Some("Deny")) {
            PermissionState::Denied
        } else {
            PermissionState::Granted
        }
    }

    /// `reg query <key> /v Value` → the REG_SZ data.
    fn reg_value(key: &str) -> Option<String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("reg")
            .args(["query", key, "/v", "Value"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines()
            .find(|l| l.trim_start().starts_with("Value"))
            .and_then(|l| l.split_whitespace().last())
            .map(str::to_string)
    }

    pub fn request(p: Permission) -> Result<PermissionState, HwError> {
        Ok(status(p))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    //! TCC through AVFoundation / CoreBluetooth class methods.

    use super::*;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{class, msg_send, msg_send_id};
    use objc2_foundation::NSString;
    use std::time::{Duration, Instant};

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}
    #[link(name = "CoreBluetooth", kind = "framework")]
    extern "C" {}

    /// `AVMediaTypeVideo` / `AVMediaTypeAudio` are the strings "vide" / "soun".
    fn media_type(p: Permission) -> &'static str {
        if p == Permission::Microphone {
            "soun"
        } else {
            "vide"
        }
    }

    fn usage_key(p: Permission) -> &'static str {
        match p {
            Permission::Camera => "NSCameraUsageDescription",
            Permission::Microphone => "NSMicrophoneUsageDescription",
            _ => "NSBluetoothAlwaysUsageDescription",
        }
    }

    /// Inside an app bundle the OS terminates a process that touches the
    /// hardware without the usage description; outside one (a binary run
    /// from a terminal) TCC asks on behalf of the terminal instead.
    fn declared(p: Permission) -> bool {
        unsafe {
            let bundle: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
            if bundle.is_null() {
                return true;
            }
            let ident: *mut AnyObject = msg_send![bundle, bundleIdentifier];
            if ident.is_null() {
                return true;
            }
            let key = NSString::from_str(usage_key(p));
            let value: *mut AnyObject = msg_send![bundle, objectForInfoDictionaryKey: &*key];
            !value.is_null()
        }
    }

    fn cb_authorization() -> Option<isize> {
        // `+[CBManager authorization]` exists from macOS 10.15.
        let cls = AnyClass::get("CBManager")?;
        let responds: Bool =
            unsafe { msg_send![cls, respondsToSelector: objc2::sel!(authorization)] };
        if !responds.as_bool() {
            return None;
        }
        Some(unsafe { msg_send![cls, authorization] })
    }

    fn av_authorization(p: Permission) -> isize {
        let ty = NSString::from_str(media_type(p));
        unsafe { msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: &*ty] }
    }

    /// AVAuthorizationStatus / CBManagerAuthorization share the numbering:
    /// 0 not determined, 1 restricted, 2 denied, 3 authorized.
    fn map(raw: isize) -> PermissionState {
        match raw {
            0 => PermissionState::Prompt,
            3 => PermissionState::Granted,
            _ => PermissionState::Denied,
        }
    }

    pub fn status(p: Permission) -> PermissionState {
        if !declared(p) {
            return PermissionState::NotDeclared;
        }
        match p {
            Permission::Bluetooth => cb_authorization()
                .map(map)
                .unwrap_or(PermissionState::Granted),
            _ => map(av_authorization(p)),
        }
    }

    pub fn request(p: Permission) -> Result<PermissionState, HwError> {
        match p {
            Permission::Bluetooth => {
                // Creating a central manager is what raises the prompt.
                let manager: Option<Retained<AnyObject>> =
                    unsafe { msg_send_id![msg_send_id![class!(CBCentralManager), alloc], init] };
                let started = Instant::now();
                let state = loop {
                    let s = status(p);
                    if s != PermissionState::Prompt || started.elapsed() > Duration::from_secs(300)
                    {
                        break s;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                };
                drop(manager);
                Ok(state)
            }
            _ => {
                let (tx, rx) = std::sync::mpsc::channel::<bool>();
                let block = block2::RcBlock::new(move |granted: Bool| {
                    let _ = tx.send(granted.as_bool());
                });
                let ty = NSString::from_str(media_type(p));
                unsafe {
                    let _: () = msg_send![
                        class!(AVCaptureDevice),
                        requestAccessForMediaType: &*ty,
                        completionHandler: &*block
                    ];
                }
                match rx.recv_timeout(Duration::from_secs(300)) {
                    Ok(true) => Ok(PermissionState::Granted),
                    Ok(false) => Ok(PermissionState::Denied),
                    Err(_) => Ok(status(p)),
                }
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
mod platform {
    use super::*;

    pub fn status(_: Permission) -> PermissionState {
        PermissionState::Granted
    }

    pub fn request(p: Permission) -> Result<PermissionState, HwError> {
        Ok(status(p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_closed_enum_maps_to_desktop_states() {
        let p = NativePermissions;
        assert_eq!(p.status(Permission::Photos), PermissionState::Granted);
        for unsupported in [
            Permission::Location,
            Permission::Notifications,
            Permission::Contacts,
        ] {
            assert_eq!(p.status(unsupported), PermissionState::Unsupported);
            assert_eq!(p.request(unsupported), Ok(PermissionState::Unsupported));
        }
        // Linux never prompts.
        #[cfg(target_os = "linux")]
        for hw in [
            Permission::Camera,
            Permission::Microphone,
            Permission::Bluetooth,
        ] {
            assert_ne!(p.status(hw), PermissionState::Prompt);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_camera_permission_follows_the_device_nodes() {
        let dir = std::env::temp_dir().join(format!("hypen-perm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            platform::camera_nodes(&dir),
            PermissionState::Granted,
            "no camera: nothing to deny"
        );
        std::fs::write(dir.join("video0"), b"").unwrap();
        assert_eq!(platform::camera_nodes(&dir), PermissionState::Granted);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
