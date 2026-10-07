//! The real Bluetooth LE backend (feature `bluetooth`): btleplug over BlueZ
//! (D-Bus, Linux), CoreBluetooth (macOS) and WinRT (Windows).
//!
//! btleplug is async; each call runs a small current-thread tokio runtime on
//! a dedicated thread. A scan lives on its own thread until its handle
//! drops (the handle stops the scan and joins).

use std::time::Duration;

use btleplug::api::{
    Central, CentralEvent, CentralState, Manager as _, Peripheral as _, ScanFilter,
};
use btleplug::platform::{Adapter, Manager};
use futures_util::StreamExt;

use crate::device::hw::{
    Advertisement, BluetoothBackend, HwError, ScanEvent, ScanHandle, ScanSink,
};

/// The platform Bluetooth stack.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativeBluetooth;

fn map_err(e: btleplug::Error) -> HwError {
    match e {
        btleplug::Error::PermissionDenied => HwError::Denied("bluetooth".into()),
        btleplug::Error::NoAdapterAvailable => HwError::NoDevice("no-adapter"),
        other => {
            let text = other.to_string();
            let lower = text.to_ascii_lowercase();
            // No Bluetooth service at all (BlueZ not running, no system
            // bus): there is no usable adapter.
            if lower.contains("serviceunknown")
                || lower.contains("service unknown")
                || lower.contains("org.bluez")
                || lower.contains("no such file")
                || lower.contains("connection refused")
            {
                HwError::NoDevice("no-adapter")
            } else if lower.contains("permission")
                || lower.contains("denied")
                || lower.contains("unauthorized")
            {
                HwError::Denied("bluetooth".into())
            } else {
                HwError::Unavailable(format!(
                    "bluetooth: {}",
                    text.chars().take(160).collect::<String>()
                ))
            }
        }
    }
}

fn runtime() -> Result<tokio::runtime::Runtime, HwError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| HwError::Internal(format!("bluetooth runtime: {e}")))
}

async fn powered_adapter() -> Result<Adapter, HwError> {
    let manager = Manager::new().await.map_err(map_err)?;
    let adapter = manager
        .adapters()
        .await
        .map_err(map_err)?
        .into_iter()
        .next()
        .ok_or(HwError::NoDevice("no-adapter"))?;
    match adapter.adapter_state().await {
        Ok(CentralState::PoweredOff) => Err(HwError::Unavailable("adapter-off".into())),
        // Unknown (some stacks cannot tell) or on: try.
        Ok(_) | Err(btleplug::Error::NotSupported(_)) => Ok(adapter),
        Err(e) => Err(map_err(e)),
    }
}

impl BluetoothBackend for NativeBluetooth {
    fn check_adapter(&self) -> Result<(), HwError> {
        let rt = runtime()?;
        rt.block_on(async {
            tokio::time::timeout(Duration::from_secs(10), powered_adapter())
                .await
                .map_err(|_| HwError::Unavailable("bluetooth-timeout".into()))?
                .map(|_| ())
        })
    }

    fn scan(&self, mut sink: ScanSink) -> Result<Box<dyn ScanHandle>, HwError> {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), HwError>>();
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("hypen-device-ble".into())
            .spawn(move || {
                let rt = match runtime() {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                rt.block_on(async move {
                    let adapter = match powered_adapter().await {
                        Ok(a) => a,
                        Err(e) => {
                            let _ = ready_tx.send(Err(e));
                            return;
                        }
                    };
                    let mut events = match adapter.events().await {
                        Ok(ev) => ev,
                        Err(e) => {
                            let _ = ready_tx.send(Err(map_err(e)));
                            return;
                        }
                    };
                    if let Err(e) = adapter.start_scan(ScanFilter::default()).await {
                        let _ = ready_tx.send(Err(map_err(e)));
                        return;
                    }
                    let _ = ready_tx.send(Ok(()));
                    loop {
                        tokio::select! {
                            _ = &mut stop_rx => break,
                            event = events.next() => match event {
                                Some(CentralEvent::DeviceDiscovered(id))
                                | Some(CentralEvent::DeviceUpdated(id))
                                | Some(CentralEvent::RssiUpdate { id, .. })
                                | Some(CentralEvent::ServicesAdvertisement { id, .. }) => {
                                    let Ok(p) = adapter.peripheral(&id).await else { continue };
                                    let Ok(Some(props)) = p.properties().await else { continue };
                                    // A cached device that is not advertising
                                    // now has no RSSI: not "nearby".
                                    let Some(rssi) = props.rssi else { continue };
                                    sink(ScanEvent::Advertisement(Advertisement {
                                        raw_id: id.to_string(),
                                        name: props.local_name.or(props.advertisement_name),
                                        rssi,
                                        services: props
                                            .services
                                            .iter()
                                            .map(|u| u.hyphenated().to_string().to_ascii_lowercase())
                                            .collect(),
                                    }));
                                }
                                Some(CentralEvent::StateUpdate(CentralState::PoweredOff)) => {
                                    sink(ScanEvent::Failed(HwError::Unavailable("adapter-off".into())));
                                    break;
                                }
                                Some(_) => {}
                                None => {
                                    sink(ScanEvent::Failed(HwError::Unavailable("scan-ended".into())));
                                    break;
                                }
                            }
                        }
                    }
                    let _ = tokio::time::timeout(Duration::from_secs(2), adapter.stop_scan()).await;
                });
            })
            .map_err(|e| HwError::Internal(format!("bluetooth thread: {e}")))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Box::new(NativeScan {
                stop: Some(stop_tx),
                thread: Some(thread),
            })),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err(HwError::Internal("bluetooth thread ended".into()))
            }
        }
    }
}

struct NativeScan {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ScanHandle for NativeScan {}

impl Drop for NativeScan {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No adapter in CI (no system D-Bus / BlueZ): the check answers an
    /// error the drivers map to `unavailable`, and never hangs or panics.
    #[test]
    fn a_machine_without_bluetooth_is_unavailable_not_a_panic() {
        let result = NativeBluetooth.check_adapter();
        if let Err(e) = result {
            assert_eq!(
                e.code(),
                hypen_engine::serialize::device::DeviceErrorCode::Unavailable,
                "{e:?}"
            );
        }
    }
}
