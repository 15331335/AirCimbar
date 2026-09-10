#!/usr/bin/env python3
"""
AirCimbar icon generator — no third-party deps, writes PNGs with zlib+struct.

The artwork is a stylised cimbar code: the real libcimbar 4-colour palette
(green / cyan / yellow / magenta, see src/lib/cimb_translator/Common.cpp)
on a dark rounded tile, with the three corner anchor marks the real format
uses for alignment.
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'icons')

# libcimbar's 4-colour palette, verbatim
PALETTE = [
    (0x00, 0xFF, 0x00),   # green
    (0x00, 0xFF, 0xFF),   # cyan
    (0xFF, 0xFF, 0x00),   # yellow
    (0xFF, 0x00, 0xFF),   # magenta
]
BG = (0x0B, 0x12, 0x20)
ANCHOR = (0xE8, 0xEE, 0xFC)


def write_png(path, w, h, px, alpha=True):
    """px: bytearray of RGBA, row-major. Set alpha=False to emit opaque RGB
    (Apple rejects app icons that carry an alpha channel)."""
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)                       # filter type 0 (None)
        if alpha:
            raw += px[y * stride:(y + 1) * stride]
        else:
            row = px[y * stride:(y + 1) * stride]
            for x in range(w):
                i = x * 4
                raw += bytes((row[i], row[i + 1], row[i + 2]))

    color_type = 6 if alpha else 2

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, color_type, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def rng(seed):
    """Deterministic LCG so every run produces identical icons."""
    s = [seed]

    def nxt():
        s[0] = (s[0] * 1103515245 + 12345) & 0x7FFFFFFF
        return s[0]
    return nxt


def render(size, rounded=True, inset=0.0, cells=4, seed=20260910):
    """A bold cimbar-style mark.

    Deliberately *not* a faithful 8x8 code: at the ~60pt a home screen icon is
    actually displayed at, 64 dithered cells collapse into visual noise. This
    uses a 4x4 grid of solid colour on a dark field, with the format's three
    corner anchors — recognisably a cimbar code, and still legible when small.
    """
    px = bytearray(size * size * 4)
    radius = size * 0.22 if rounded else 0.0
    pad = size * inset

    margin = size * 0.13 + pad
    inner = size - 2 * margin
    cell = inner / cells

    nxt = rng(seed)
    # a fixed, hand-picked arrangement: random colour noise reads as clutter
    pattern = [
        [0, 1, 2, 3],
        [3, 2, 0, 1],
        [1, 3, 3, 0],
        [2, 0, 1, 2],
    ]
    anchors = {(0, 0), (cells - 1, 0), (0, cells - 1)}   # TL, TR, BL

    for y in range(size):
        for x in range(size):
            i = (y * size + x) * 4
            fx, fy = x + 0.5, y + 0.5

            if rounded:
                cx = min(max(fx, radius), size - radius)
                cy = min(max(fy, radius), size - radius)
                dx, dy = fx - cx, fy - cy
                if dx * dx + dy * dy > radius * radius:
                    px[i + 3] = 0
                    continue

            px[i], px[i + 1], px[i + 2], px[i + 3] = BG[0], BG[1], BG[2], 255

            gx = int((fx - margin) // cell)
            gy = int((fy - margin) // cell)
            if not (0 <= gx < cells and 0 <= gy < cells):
                continue

            ox = (fx - margin) - gx * cell
            oy = (fy - margin) - gy * cell
            gutter = cell * 0.10
            if ox < gutter or oy < gutter or ox > cell - gutter or oy > cell - gutter:
                continue

            if (gx, gy) in anchors:
                px[i], px[i + 1], px[i + 2] = ANCHOR
            else:
                r, g, b = PALETTE[pattern[gy][gx]]
                px[i], px[i + 1], px[i + 2] = r, g, b

    return px


def main():
    os.makedirs(OUT, exist_ok=True)

    def save(path, size, rounded, inset, alpha=True):
        write_png(path, size, size, render(size, rounded, inset), alpha=alpha)
        print('wrote', os.path.relpath(path, os.path.dirname(OUT)), f'{size}x{size}')

    # ---- PWA / manifest ----
    save(os.path.join(OUT, 'icon-192.png'), 192, True, 0.0)
    save(os.path.join(OUT, 'icon-512.png'), 512, True, 0.0)
    save(os.path.join(OUT, 'icon-maskable-512.png'), 512, False, 0.10)

    # ---- iOS home screen ----
    # iOS probes /apple-touch-icon.png and /apple-touch-icon-precomposed.png at
    # the *root* of the site before falling back to the link tag, and shows a
    # generic letter tile when it finds nothing usable. So ship real files at
    # the root as well as the sized set under icons/.
    app_root = os.path.dirname(OUT)
    # Apple asks for no alpha channel in home screen icons, and iOS applies its
    # own corner mask, so these are square and opaque RGB.
    for name, size in (('apple-touch-icon.png', 180),
                       ('apple-touch-icon-precomposed.png', 180)):
        save(os.path.join(app_root, name), size, False, 0.04, alpha=False)
    for size in (120, 152, 167, 180, 192):
        save(os.path.join(OUT, f'apple-touch-icon-{size}.png'), size, False, 0.04, alpha=False)
    print('wrote', 'app/icons/apple-touch-icon-{120,152,167,180,192}.png')

    # ---- native app icon (Xcode asset catalog) ----
    # Apple rejects app icons carrying an alpha channel, hence alpha=False.
    repo_root = os.path.dirname(os.path.dirname(OUT))
    native_set = os.path.join(repo_root, 'native', 'AirCimbar',
                              'Assets.xcassets', 'AppIcon.appiconset')
    os.makedirs(native_set, exist_ok=True)
    write_png(os.path.join(native_set, 'icon-1024.png'), 1024, 1024,
              render(1024, rounded=False, inset=0.06), alpha=False)
    print('wrote native app icon 1024x1024 (opaque RGB)')


if __name__ == '__main__':
    main()
