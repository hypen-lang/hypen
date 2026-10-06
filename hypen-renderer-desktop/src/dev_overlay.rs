//! Opt-in native performance HUD state.
//!
//! Kept behind `dev-overlay` so production builds pay no dependency, sampling,
//! timer, paint, or memory cost. The timer samples once per second; it does not
//! turn the renderer's demand-driven loop into a permanent animation loop.

use std::time::Duration;
use sysinfo::{get_current_pid, ProcessRefreshKind, ProcessesToUpdate, System};

pub(crate) const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) struct DevOverlay {
    system: System,
    pid: Option<sysinfo::Pid>,
    cpu: Option<f32>,
    memory_bytes: Option<u64>,
    last_frame_time: Option<Duration>,
    label: String,
}

impl DevOverlay {
    pub(crate) fn new() -> Self {
        let mut system = System::new();
        let pid = get_current_pid().ok();
        if let Some(pid) = pid {
            refresh_process(&mut system, pid);
        }
        Self {
            system,
            pid,
            cpu: None,
            memory_bytes: None,
            last_frame_time: None,
            label: "RAM --  CPU --  FRAME --  FPS --".into(),
        }
    }

    /// Record the cost of the most recently rendered frame. Hypen is
    /// demand-driven, so counting presents per wall-clock second would report
    /// 0 FPS while an idle app is behaving perfectly. The HUD instead shows
    /// this duration and its equivalent continuous frame rate.
    pub(crate) fn frame_presented(&mut self, duration: Duration, overlay_only: bool) {
        // Sampling CPU/RAM asks winit for one HUD-only redraw per second.
        // That maintenance frame is not application work and must not replace
        // the last real frame cost; otherwise an idle app appears to run at
        // whatever speed the tiny overlay happens to paint.
        if overlay_only {
            return;
        }
        self.last_frame_time = Some(duration);
        self.refresh_label();
    }

    pub(crate) fn sample(&mut self) {
        if let Some(pid) = self.pid {
            refresh_process(&mut self.system, pid);
            if let Some(process) = self.system.process(pid) {
                self.cpu = Some(process.cpu_usage());
                self.memory_bytes = Some(process.memory());
            }
        }
        self.refresh_label();
    }

    pub(crate) fn label(&self) -> &str {
        &self.label
    }

    fn refresh_label(&mut self) {
        self.label = format_metrics(self.cpu, self.memory_bytes, self.last_frame_time);
    }
}

fn refresh_process(system: &mut System, pid: sysinfo::Pid) {
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(std::slice::from_ref(&pid)),
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
}

fn equivalent_fps(duration: Duration) -> Option<f64> {
    let seconds = duration.as_secs_f64();
    (seconds > 0.0).then_some(1.0 / seconds)
}

fn format_metrics(
    cpu: Option<f32>,
    memory_bytes: Option<u64>,
    frame_time: Option<Duration>,
) -> String {
    let memory = memory_bytes
        .map(|bytes| format!("{:.0} MB", bytes as f64 / (1024.0 * 1024.0)))
        .unwrap_or_else(|| "--".into());
    let cpu = cpu
        .map(|value| format!("{value:.1}%"))
        .unwrap_or_else(|| "--".into());
    let frame = frame_time
        .map(|duration| format!("{:.1} ms", duration.as_secs_f64() * 1000.0))
        .unwrap_or_else(|| "--".into());
    let fps = frame_time
        .and_then(equivalent_fps)
        .map(|value| format!("{value:.0}"))
        .unwrap_or_else(|| "--".into());
    format!("RAM {memory}  CPU {cpu}  FRAME {frame}  {fps} FPS")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_cost_maps_to_equivalent_continuous_fps() {
        assert!((equivalent_fps(Duration::from_micros(16_667)).unwrap() - 60.0).abs() < 0.01);
        assert_eq!(equivalent_fps(Duration::ZERO), None);
    }

    #[test]
    fn metrics_label_uses_process_percent_and_resident_mib() {
        assert_eq!(
            format_metrics(
                Some(12.34),
                Some(192 * 1024 * 1024),
                Some(Duration::from_millis(8))
            ),
            "RAM 192 MB  CPU 12.3%  FRAME 8.0 ms  125 FPS"
        );
    }

    #[test]
    fn idle_hud_keeps_the_last_render_cost_instead_of_reporting_zero_fps() {
        let mut overlay = DevOverlay::new();
        overlay.cpu = Some(3.2);
        overlay.memory_bytes = Some(64 * 1024 * 1024);
        overlay.frame_presented(Duration::from_millis(10), false);
        let label = overlay.label().to_string();
        assert_eq!(label, "RAM 64 MB  CPU 3.2%  FRAME 10.0 ms  100 FPS");
        assert_eq!(overlay.label(), label);
    }

    #[test]
    fn metrics_only_redraw_does_not_measure_itself() {
        let mut overlay = DevOverlay::new();
        overlay.cpu = Some(3.2);
        overlay.memory_bytes = Some(64 * 1024 * 1024);
        overlay.frame_presented(Duration::from_millis(10), false);

        overlay.frame_presented(Duration::from_millis(1), true);

        assert_eq!(
            overlay.label(),
            "RAM 64 MB  CPU 3.2%  FRAME 10.0 ms  100 FPS"
        );
    }
}
