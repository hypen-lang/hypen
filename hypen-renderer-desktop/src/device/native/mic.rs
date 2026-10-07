//! The real microphone backend (feature `mic`): cpal over ALSA (Linux; it
//! reaches PulseAudio / PipeWire through their ALSA plugins), CoreAudio
//! (macOS) and WASAPI (Windows).
//!
//! The default input device is opened in its default configuration (every
//! device supports that one); `crate::device::pcm` converts to the
//! requested rate / channel count, so no device needs to support the
//! requested format natively. A cpal `Stream` is not `Send` on every
//! platform, so it is built, run and dropped on a dedicated thread that
//! the returned handle stops and joins.

use std::sync::mpsc;
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, SampleFormat};

use crate::device::hw::{AudioBlock, AudioErrorSink, AudioSink, HwError, MicBackend, MicStream};

/// The platform audio input.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativeMic;

fn map_err(e: cpal::Error) -> HwError {
    match e.kind() {
        ErrorKind::PermissionDenied => HwError::Denied("microphone".into()),
        ErrorKind::DeviceNotAvailable | ErrorKind::HostUnavailable => {
            HwError::NoDevice("no-microphone")
        }
        ErrorKind::DeviceBusy => HwError::Unavailable("microphone-busy".into()),
        _ => HwError::Unavailable(format!("microphone: {e}").chars().take(160).collect()),
    }
}

/// Whether a stream error ends the recording (a changed route or an
/// overrun does not).
fn fatal(e: &cpal::Error) -> bool {
    matches!(
        e.kind(),
        ErrorKind::DeviceNotAvailable
            | ErrorKind::HostUnavailable
            | ErrorKind::PermissionDenied
            | ErrorKind::StreamInvalidated
    )
}

impl MicBackend for NativeMic {
    fn has_input(&self) -> bool {
        cpal::default_host().default_input_device().is_some()
    }

    fn start(
        &self,
        sink: AudioSink,
        on_error: AudioErrorSink,
    ) -> Result<Box<dyn MicStream>, HwError> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), HwError>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("hypen-device-mic".into())
            .spawn(move || {
                let stream = match build(sink, on_error) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(map_err(e)));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                // Runs until the handle drops its sender.
                let _ = stop_rx.recv();
                let _ = stream.pause();
                drop(stream);
            })
            .map_err(|e| HwError::Internal(format!("mic thread: {e}")))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Box::new(NativeMicStream {
                stop: Some(stop_tx),
                thread: Some(thread),
            })),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err(HwError::Internal("mic thread ended".into()))
            }
        }
    }
}

fn build(mut sink: AudioSink, mut on_error: AudioErrorSink) -> Result<cpal::Stream, HwError> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or(HwError::NoDevice("no-microphone"))?;
    let supported = device.default_input_config().map_err(map_err)?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let rate = config.sample_rate;
    let channels = config.channels;
    let err_cb = move |e: cpal::Error| {
        if fatal(&e) {
            on_error(map_err(e));
        } else {
            log::debug!("device: microphone stream: {e}");
        }
    };
    macro_rules! stream_of {
        ($t:ty, $conv:expr) => {
            device.build_input_stream::<$t, _, _>(
                config,
                move |data: &[$t], _| {
                    let conv = $conv;
                    sink(AudioBlock {
                        sample_rate: rate,
                        channels,
                        samples: data.iter().map(|&s| conv(s)).collect(),
                    })
                },
                err_cb,
                None,
            )
        };
    }
    let stream = match format {
        SampleFormat::F32 => stream_of!(f32, |s: f32| s),
        SampleFormat::F64 => stream_of!(f64, |s: f64| s as f32),
        SampleFormat::I16 => stream_of!(i16, |s: i16| f32::from(s) / 32_768.0),
        SampleFormat::U16 => stream_of!(u16, |s: u16| (f32::from(s) - 32_768.0) / 32_768.0),
        SampleFormat::I32 => stream_of!(i32, |s: i32| s as f32 / 2_147_483_648.0),
        SampleFormat::U32 => stream_of!(u32, |s: u32| (s as f64 / 2_147_483_648.0 - 1.0) as f32),
        SampleFormat::I8 => stream_of!(i8, |s: i8| f32::from(s) / 128.0),
        SampleFormat::U8 => stream_of!(u8, |s: u8| (f32::from(s) - 128.0) / 128.0),
        other => {
            return Err(HwError::Unavailable(format!(
                "unsupported-sample-format:{other:?}"
            )));
        }
    };
    stream.map_err(map_err)
}

struct NativeMicStream {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl MicStream for NativeMicStream {}

impl Drop for NativeMicStream {
    fn drop(&mut self) {
        drop(self.stop.take());
        // Joined so no audio callback runs after the drop returns.
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
