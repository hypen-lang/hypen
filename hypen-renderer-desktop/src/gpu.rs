//! wgpu surface management + Vello scene compositor.
//!
//! Replaces the Phase 1 hand-rolled CPU-pixmap upload + fullscreen
//! blit with [`vello`], which encodes a 2D [`Scene`](vello::Scene)
//! into wgpu compute + render passes and rasterises directly on the
//! GPU. The painter side now emits Vello scene commands instead of
//! per-pixel writes; on a modern GPU per-frame paint cost moves off
//! the main thread entirely.
//!
//! Vello 0.8 is pinned to wgpu 28; that's what we depend on too.
//! Vello's compute pipeline writes to an intermediate
//! `Rgba8Unorm + STORAGE_BINDING` texture; a `TextureBlitter` then
//! copies that intermediate into the real surface texture (which
//! may be BGRA / sRGB / whatever the platform prefers).
//! [`vello::util::RenderContext`] does this bookkeeping for us — we
//! own one per `Gpu` instance.

use std::path::PathBuf;
use std::sync::Arc;
use vello::util::{RenderContext, RenderSurface};
use vello::{AaConfig, AaSupport, Renderer, RendererOptions, Scene};
use winit::window::Window;

pub struct Gpu {
    /// Vello's render-context owns the wgpu device / queue / adapter
    /// used for the surface. We borrow them out via `device()` /
    /// `queue()` for the painter.
    pub render_ctx: RenderContext,
    pub surface: RenderSurface<'static>,
    pub size: (u32, u32),
    /// One Vello renderer per device. Reused across `present`.
    renderer: Renderer,
    /// Page background — clears the surface each frame. Matches the
    /// `0xfb fbfd` the CPU painter used.
    base_color: vello::peniko::Color,
    /// Persistent wgpu pipeline cache. Initialised from disk in
    /// `new()` and written back in `Drop` so cold-start shader
    /// compilation reuses prior work across launches. `None` if the
    /// platform cache directory can't be resolved or the backend
    /// doesn't support pipeline caches (Metal: no-op, Vulkan / D3D12:
    /// real win). Held as `Option` so callers can drop it via
    /// `Drop` without panicking on the no-op case.
    pipeline_cache: Option<wgpu::PipelineCache>,
}

impl Gpu {
    pub async fn new(window: Arc<Window>) -> Self {
        let inner = window.inner_size();
        let size = (inner.width.max(1), inner.height.max(1));
        let mut render_ctx = RenderContext::new();
        let surface = render_ctx
            .create_surface(window.clone(), size.0, size.1, wgpu::PresentMode::Fifo)
            .await
            .expect("create vello surface");
        // macOS: tell the CAMetalLayer to commit presents inside a
        // CATransaction (eliminates the live-resize stretch flash —
        // see `crate::macos`). When the flag is set, wgpu-hal-metal's
        // present already calls `waitUntilScheduled` internally before
        // `[drawable present]`, so we don't add our own GPU sync.
        // No-op on other platforms / non-Metal backends.
        #[cfg(target_os = "macos")]
        crate::macos::configure_window_layer(&window);
        let dev_id = surface.dev_id;
        let device = &render_ctx.devices[dev_id].device;
        // The on-screen painter only uses `AaConfig::Area` (see
        // `present()` below). `AaSupport::all()` would also compile
        // Vello's MSAA8 + MSAA16 pipelines and allocate their
        // intermediate buffers — ~15-25 MB of permanent overhead for
        // shaders + buffers that never run. `area_only()` is the
        // smallest pipeline footprint Vello supports.
        let pipeline_cache = load_pipeline_cache(device);
        let renderer = Renderer::new(
            device,
            RendererOptions {
                use_cpu: false,
                antialiasing_support: AaSupport::area_only(),
                num_init_threads: std::num::NonZeroUsize::new(1),
                pipeline_cache: pipeline_cache.clone(),
            },
        )
        .expect("vello renderer");
        Self {
            render_ctx,
            surface,
            size,
            renderer,
            base_color: vello::peniko::Color::from_rgba8(0xfb, 0xfb, 0xfd, 0xff),
            pipeline_cache,
        }
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.render_ctx.devices[self.surface.dev_id].device
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.render_ctx.devices[self.surface.dev_id].queue
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        if w == 0 || h == 0 {
            return;
        }
        self.size = (w, h);
        self.render_ctx.resize_surface(&mut self.surface, w, h);
    }

    /// Render `scene` to the next surface texture and present it.
    /// `scene` is owned by the caller (the painter); the painter
    /// rebuilds it per frame from `LayoutPass.items`.
    pub fn present(&mut self, scene: &Scene) -> Result<(), &'static str> {
        let device_handle = &self.render_ctx.devices[self.surface.dev_id];
        let device = &device_handle.device;
        let queue = &device_handle.queue;

        let surface_texture = match self.surface.surface.get_current_texture() {
            Ok(t) => t,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                self.surface.surface.configure(device, &self.surface.config);
                return Ok(());
            }
            Err(_) => return Err("surface unavailable"),
        };
        let params = vello::RenderParams {
            base_color: self.base_color,
            width: self.size.0,
            height: self.size.1,
            antialiasing_method: AaConfig::Area,
        };
        // 1. Vello renders into the intermediate Rgba8Unorm texture.
        self.renderer
            .render_to_texture(device, queue, scene, &self.surface.target_view, &params)
            .map_err(|_| "vello render failed")?;
        // 2. Blit the intermediate into the real swapchain image.
        let surface_view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("hypen-desktop blit"),
        });
        self.surface.blitter.copy(
            device,
            &mut encoder,
            &self.surface.target_view,
            &surface_view,
        );
        queue.submit(Some(encoder.finish()));
        // On macOS with `presentsWithTransaction = YES`, wgpu-hal-metal
        // calls `commandBuffer.waitUntilScheduled` then `[drawable
        // present]` inside this call — that's the synchronisation we
        // need with AppKit's compositor. No additional GPU sync.
        surface_texture.present();
        // Drive wgpu's internal resource tracker. Without this, each
        // frame's command encoder, bind groups, and Vello's intermediate
        // compute buffers stay alive in the device's pending-work list
        // until *something* polls — long-running sessions accumulate
        // hundreds of MB → GB of dead-but-tracked GPU and CPU shadow
        // memory. `PollType::Poll` returns immediately if the GPU is
        // still busy; we don't need to wait.
        if let Err(e) = device.poll(wgpu::PollType::Poll) {
            log::warn!("device poll failed: {e:?}");
        }
        Ok(())
    }
}

impl Drop for Gpu {
    fn drop(&mut self) {
        if let Some(cache) = self.pipeline_cache.take() {
            save_pipeline_cache(&cache);
        }
    }
}

/// Cache file the wgpu pipeline cache is serialised to and loaded from
/// on the next launch. wgpu's `fallback: true` flag means a stale
/// file (driver update, wgpu version bump, GPU swap) downgrades
/// gracefully to "start empty" instead of erroring — we don't need
/// version stamps or invalidation logic of our own. Per-app path
/// keeps multiple Hypen-based binaries from stomping on each other.
const PIPELINE_CACHE_FILE: &str = "vello-pipeline.bin";

fn pipeline_cache_path() -> Option<PathBuf> {
    let mut path = dirs::cache_dir()?;
    path.push("hypen");
    path.push(PIPELINE_CACHE_FILE);
    Some(path)
}

fn load_pipeline_cache(device: &wgpu::Device) -> Option<wgpu::PipelineCache> {
    // `create_pipeline_cache` is *fatally* unsafe when the device
    // wasn't created with the `PIPELINE_CACHE` feature — wgpu hits a
    // validation error and panics out through winit's app delegate.
    // The `fallback: true` flag on the descriptor only handles
    // invalid *data*; a missing feature is a hard panic. So gate on
    // the feature being present *before* we ever touch the API.
    //
    // Today this is a no-op everywhere: Vello's `RenderContext`
    // doesn't request `PIPELINE_CACHE` from the adapter on any
    // backend, so the feature is never present at the device level.
    // The cache file machinery is wired and waiting — the day we
    // bypass `RenderContext` to request the feature on Vulkan / D3D12
    // (Metal doesn't have it; CoreGraphics caches at the driver
    // level), launches will start populating the file.
    if !device.features().contains(wgpu::Features::PIPELINE_CACHE) {
        log::debug!(
            "pipeline cache: device lacks PIPELINE_CACHE feature (backend doesn't \
             support it, or feature not requested at device creation) — skipping"
        );
        return None;
    }
    let path = pipeline_cache_path()?;
    let data = std::fs::read(&path).ok();
    // SAFETY: the unsafe-ness here is wgpu's: it can't fully validate
    // that an opaque blob of driver bytecode is safe to feed back into
    // a driver. Risks if the bytes were tampered with externally are
    // on the caller. We feed bytes from a file we wrote ourselves
    // last session, and `fallback: true` makes wgpu downgrade to an
    // empty cache when the *data* fails validation (different driver
    // / GPU / wgpu version) so the worst case is "as if the cache
    // wasn't there" — never UB. The feature-availability check above
    // covers the panic path.
    let cache = unsafe {
        device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
            label: Some("hypen-vello-pipeline-cache"),
            data: data.as_deref(),
            fallback: true,
        })
    };
    Some(cache)
}

fn save_pipeline_cache(cache: &wgpu::PipelineCache) {
    let Some(path) = pipeline_cache_path() else {
        return;
    };
    // Backends without pipeline-cache support (Metal, WebGPU) return
    // `None` here — just skip writing rather than overwrite a real
    // cache from another backend that ran on the same machine.
    let Some(bytes) = cache.get_data() else {
        return;
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("pipeline cache: create dir failed: {e}");
            return;
        }
    }
    match std::fs::write(&path, &bytes) {
        Ok(()) => log::debug!(
            "pipeline cache: saved {} bytes to {}",
            bytes.len(),
            path.display()
        ),
        Err(e) => log::warn!("pipeline cache: write failed: {e}"),
    }
}
