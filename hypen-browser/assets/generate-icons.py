#!/usr/bin/env python3
"""Generate the Hypen Browser app icon in every platform format.

The design: the brand mark (the white lowercase h over the pink + yellow
"wing" pair, verbatim paths from hypen-docs/public/favicon.svg) on a dark
rounded tile, orbited by a retro comet: a starburst head at the raised
tip whose tail sweeps the tilted ellipse — in front of the mark below,
behind it above — and fades out before reaching the head again from the
far side, so the loop never closes. Glossy top sheen over everything.
Paths are drawn directly (no SVG rasteriser needed), supersampled at
4096px and downscaled per size.

Outputs (all under this directory):
  icons/icon-{16,32,48,64,128,256,512,1024}.png   full-bleed rounded tile
  icons/icon.png                                  512px copy (Linux desktop icon)
  icons/icon.ico                                  Windows multi-size icon
  icons/icon.icns                                 macOS icon (Apple margin variant)

Requires:  pip install pillow numpy
Run:       python3 generate-icons.py
"""

import io
import math
import re
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
OUT = HERE / "icons"

# ---------------------------------------------------------------------------
# Brand geometry — verbatim from hypen-docs/public/favicon.svg (795x795 space).
# ---------------------------------------------------------------------------

WING_PINK = (
    "M414 688H201V609.439C207.956 609.108 238.894 608.644 307.004 609.439"
    "C375.114 610.235 414 664 414 688Z"
)
WING_YELLOW = (
    "M370.5 609H595.5V687.561C588.544 687.892 557.606 688.356 489.496 687.561"
    "C421.386 686.765 451.5 617.5 370.5 609Z"
)
H_GLYPH = (
    "M424.4 253.4C464.4 253.4 496.6 265.4 521 289.4C545.8 313.4 558.2 349 "
    "558.2 396.2V581H464.6V410.6C464.6 385 459 366 447.8 353.6C436.6 340.8 "
    "420.4 334.4 399.2 334.4C375.6 334.4 356.8 341.8 342.8 356.6C328.8 371 "
    "321.8 392.6 321.8 421.4V581H228.2V135.8H321.8V291.8C334.2 279.4 349.2 "
    "270 366.8 263.6C384.4 256.8 403.6 253.4 424.4 253.4Z"
)

BRAND_SPACE = 795.0
PINK = (255, 167, 225, 255)  # #FFA7E1
YELLOW = (255, 236, 167, 255)  # #FFECA7
WHITE = (255, 255, 255, 255)
BG_TOP = (32, 32, 39, 255)  # subtle lift over the flat #161616
BG_BOTTOM = (17, 17, 20, 255)

SS = 4096  # supersampled master edge
CORNER = 0.225  # rounded-tile corner radius as a fraction of the edge
MARK_SCALE = 0.86  # shrink the brand mark to give the orbit ring air
RING_TILT = 22.0  # degrees, counterclockwise — right tip raised
RING_A = 0.435  # semi-major axis, fraction of edge
RING_B = 0.165  # semi-minor axis, fraction of edge
RING_W = 0.020  # stroke width, fraction of edge
TAIL = 0.80  # fraction of the orbit the comet tail covers before fading out
TAIL_GAMMA = 1.25  # taper curve — higher = dimmer sooner behind the head


def flatten_path(d, steps=48):
    """Flatten an absolute M/L/H/V/C/Z SVG path into polygons."""
    tokens = re.findall(r"[MLHVCZ]|-?\d*\.?\d+", d)
    polys, pts, i = [], [], 0
    cx = cy = 0.0
    while i < len(tokens):
        cmd = tokens[i]
        i += 1
        if cmd == "M":
            if pts:
                polys.append(pts)
            cx, cy = float(tokens[i]), float(tokens[i + 1])
            i += 2
            pts = [(cx, cy)]
        elif cmd == "L":
            cx, cy = float(tokens[i]), float(tokens[i + 1])
            i += 2
            pts.append((cx, cy))
        elif cmd == "H":
            cx = float(tokens[i])
            i += 1
            pts.append((cx, cy))
        elif cmd == "V":
            cy = float(tokens[i])
            i += 1
            pts.append((cx, cy))
        elif cmd == "C":
            # One or more cubic segments may follow a single C.
            while i + 5 < len(tokens) and re.match(r"-?\d", tokens[i]):
                x1, y1, x2, y2, x3, y3 = (float(tokens[i + k]) for k in range(6))
                i += 6
                for s in range(1, steps + 1):
                    t = s / steps
                    mt = 1.0 - t
                    px = (
                        mt**3 * cx
                        + 3 * mt**2 * t * x1
                        + 3 * mt * t**2 * x2
                        + t**3 * x3
                    )
                    py = (
                        mt**3 * cy
                        + 3 * mt**2 * t * y1
                        + 3 * mt * t**2 * y2
                        + t**3 * y3
                    )
                    pts.append((px, py))
                cx, cy = x3, y3
        elif cmd == "Z":
            if pts:
                polys.append(pts)
                pts = []
    if pts:
        polys.append(pts)
    return polys


def draw_path(draw, d, fill, scale, dx=0.0, dy=0.0):
    for poly in flatten_path(d):
        draw.polygon([(x * scale + dx, y * scale + dy) for x, y in poly], fill=fill)


def brand_gradient():
    """Horizontal pink → yellow gradient, the wings' two colors."""
    grad = Image.linear_gradient("L").rotate(90).resize((SS, SS))
    return Image.composite(
        Image.new("RGBA", (SS, SS), PINK),
        Image.new("RGBA", (SS, SS), YELLOW),
        grad,
    )


def ring_alpha(width_frac, blur=0.0):
    """Alpha mask of the tilted orbit ellipse outline."""
    layer = Image.new("L", (SS, SS), 0)
    d = ImageDraw.Draw(layer)
    cx = cy = SS / 2
    a, b = SS * RING_A, SS * RING_B
    d.ellipse(
        [cx - a, cy - b, cx + a, cy + b],
        outline=255,
        width=max(1, int(SS * width_frac)),
    )
    layer = layer.rotate(RING_TILT, center=(cx, cy), resample=Image.BICUBIC)
    if blur:
        layer = layer.filter(ImageFilter.GaussianBlur(SS * blur))
    return layer


def comet_fade_mask():
    """Angular brightness along the orbit: 255 at the starburst head
    (the ellipse's raised right tip), tapering around the loop in the
    travel direction (down across the front first, then up the back)
    and reaching 0 after ``TAIL`` of the circumference — the gap that
    keeps the tail from touching the head on the far side.

    Computed per-pixel from the parametric angle in the ring's local
    frame, at 1024px and upscaled — the fade is smooth, full res would
    just burn memory.
    """
    res = 1024
    c = res / 2.0
    y, x = np.mgrid[0:res, 0:res].astype(np.float64)
    xr, yr = x - c, y - c
    # View → local ellipse frame (inverse of the CCW tilt).
    th = math.radians(RING_TILT)
    u = math.cos(th) * xr - math.sin(th) * yr
    v = math.sin(th) * xr + math.cos(th) * yr
    # Parametric angle, 0 at the head, increasing toward the back/far
    # side (v < 0, screen-up) — the direction the tail trails. Full at
    # the back of the orbit, fading as it comes around the front.
    ang = np.arctan2(v / (res * RING_B), u / (res * RING_A))
    d = np.mod(-ang, 2.0 * math.pi) / (2.0 * math.pi)
    fade = np.clip(1.0 - d / TAIL, 0.0, 1.0) ** TAIL_GAMMA
    mask = Image.fromarray((fade * 255.0).astype(np.uint8), "L")
    return mask.resize((SS, SS), Image.BICUBIC)


def front_half_mask():
    """Half-plane below the ring's tilted major axis — the near side of
    the orbit, drawn in front of the mark."""
    th = math.radians(RING_TILT)
    dx, dy = math.cos(th), -math.sin(th)  # axis direction (view coords)
    nx, ny = math.sin(th), math.cos(th)  # normal pointing screen-down
    c = SS / 2
    L = SS * 3
    poly = [
        (c - L * dx, c - L * dy),
        (c + L * dx, c + L * dy),
        (c + L * dx + L * nx, c + L * dy + L * ny),
        (c - L * dx + L * nx, c - L * dy + L * ny),
    ]
    mask = Image.new("L", (SS, SS), 0)
    ImageDraw.Draw(mask).polygon(poly, fill=255)
    return mask


def sparkle(layer, x, y, r_long, r_short):
    """Four-point retro starburst with a soft glow behind it."""
    glow = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [x - r_long, y - r_long, x + r_long, y + r_long], fill=(255, 245, 210, 190)
    )
    layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(r_long * 0.65)))
    d = ImageDraw.Draw(layer)
    d.polygon(
        [(x, y - r_long), (x + r_short, y), (x, y + r_long), (x - r_short, y)],
        fill=WHITE,
    )
    d.polygon(
        [(x - r_long, y), (x, y + r_short), (x + r_long, y), (x, y - r_short)],
        fill=WHITE,
    )


def render_master():
    """Full-bleed rounded glossy tile at SS resolution."""
    # Vertical gradient background.
    grad = Image.linear_gradient("L").resize((SS, SS))
    bg = Image.composite(
        Image.new("RGBA", (SS, SS), BG_BOTTOM),
        Image.new("RGBA", (SS, SS), BG_TOP),
        grad,
    )

    # Warm glow rising off the wings.
    glow = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([SS * 0.06, SS * 0.52, SS * 0.62, SS * 1.10], fill=(255, 167, 225, 76))
    gd.ellipse([SS * 0.42, SS * 0.56, SS * 0.98, SS * 1.12], fill=(255, 236, 167, 64))
    bg.alpha_composite(glow.filter(ImageFilter.GaussianBlur(SS * 0.10)))

    # Comet tail: the orbit ellipse, colored with the brand gradient
    # and multiplied by the angular fade so it trails off the starburst
    # head and dies out before closing the loop. Built once, split into
    # the far half (behind the mark) and near half (in front).
    fade = comet_fade_mask()
    ring_colors = brand_gradient()
    halo = ring_colors.copy()
    halo.putalpha(
        ImageChops.multiply(
            ring_alpha(RING_W * 2.2, blur=0.008).point(lambda v: v * 45 // 255), fade
        )
    )
    core = ring_colors.copy()
    core.putalpha(ImageChops.multiply(ring_alpha(RING_W), fade))
    ring = halo
    ring.alpha_composite(core)
    # Glossy edge: a thinner, brighter pass along the same orbit.
    sheen = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    sheen.paste(
        (255, 255, 255, 150),
        (0, 0),
        ImageChops.multiply(ring_alpha(RING_W * 0.35, blur=0.001), fade),
    )
    ring.alpha_composite(sheen)

    front = front_half_mask()
    back_mask = ImageChops.subtract(ring.getchannel("A"), front)
    front_mask = ImageChops.multiply(ring.getchannel("A"), front)
    ring_back = ring.copy()
    ring_back.putalpha(back_mask)
    ring_front = ring.copy()
    ring_front.putalpha(front_mask)

    bg.alpha_composite(ring_back)

    # The brand mark, slightly shrunk so the ring has air.
    scale = SS / BRAND_SPACE * MARK_SCALE
    off = SS * (1.0 - MARK_SCALE) / 2.0
    shadow = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    draw_path(
        ImageDraw.Draw(shadow), H_GLYPH, (0, 0, 0, 130), scale, dx=off, dy=off + SS * 0.012
    )
    bg.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(SS * 0.012)))
    d = ImageDraw.Draw(bg)
    draw_path(d, WING_PINK, PINK, scale, dx=off, dy=off)
    draw_path(d, WING_YELLOW, YELLOW, scale, dx=off, dy=off)
    draw_path(d, H_GLYPH, WHITE, scale, dx=off, dy=off)

    bg.alpha_composite(ring_front)

    # Starburst comet head at the orbit's raised right tip.
    th = math.radians(RING_TILT)
    tip_x = SS / 2 + SS * RING_A * math.cos(th)
    tip_y = SS / 2 - SS * RING_A * math.sin(th)
    sparkle(bg, tip_x, tip_y, SS * 0.058, SS * 0.012)

    # Glossy top sheen — a wide highlight ellipse fading down the tile.
    dome = Image.new("L", (SS, SS), 0)
    ImageDraw.Draw(dome).ellipse([-SS * 0.25, -SS * 0.78, SS * 1.25, SS * 0.50], fill=255)
    fade = (
        Image.linear_gradient("L")
        .resize((SS, SS))
        .point(lambda v: max(0, 58 - v * 58 // 130))
    )
    gloss = Image.new("RGBA", (SS, SS), (255, 255, 255, 0))
    gloss.putalpha(ImageChops.multiply(dome, fade))
    bg.alpha_composite(gloss)

    # Rounded-corner alpha mask.
    mask = Image.new("L", (SS, SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, SS - 1, SS - 1], radius=int(SS * CORNER), fill=255
    )
    bg.putalpha(mask)
    return bg


def at(master, size):
    return master.resize((size, size), Image.LANCZOS)


def macos_variant(master, size):
    """Apple-style icon: the tile at ~82% with a transparent margin."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = max(1, round(size * 0.82))
    tile = master.resize((inner, inner), Image.LANCZOS)
    off = (size - inner) // 2
    canvas.alpha_composite(tile, (off, off))
    return canvas


def write_icns(master, path):
    """ICNS with PNG payloads (types supported since OS X 10.7)."""
    types = [
        ("icp4", 16),
        ("icp5", 32),
        ("ic11", 32),  # 16pt @2x
        ("icp6", 64),
        ("ic12", 64),  # 32pt @2x
        ("ic07", 128),
        ("ic08", 256),
        ("ic13", 256),  # 128pt @2x
        ("ic09", 512),
        ("ic14", 512),  # 256pt @2x
        ("ic10", 1024),  # 512pt @2x
    ]
    chunks = b""
    for tag, px in types:
        buf = io.BytesIO()
        macos_variant(master, px).save(buf, "PNG")
        data = buf.getvalue()
        chunks += tag.encode("ascii") + struct.pack(">I", len(data) + 8) + data
    path.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    master = render_master()

    sizes = [16, 32, 48, 64, 128, 256, 512, 1024]
    for s in sizes:
        at(master, s).save(OUT / f"icon-{s}.png")
    at(master, 512).save(OUT / "icon.png")

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [at(master, s) for s in ico_sizes]
    frames[-1].save(
        OUT / "icon.ico",
        format="ICO",
        append_images=frames[:-1],
        sizes=[(s, s) for s in ico_sizes],
    )

    write_icns(master, OUT / "icon.icns")
    print(f"wrote {len(sizes) + 3} icon files to {OUT}")


if __name__ == "__main__":
    main()
