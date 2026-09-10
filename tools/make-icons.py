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


def render(size, rounded=True, inset=0.0):
    px = bytearray(size * size * 4)
    radius = size * 0.22 if rounded else 0.0
    pad = size * inset

    # grid geometry: 8x8 tiles with a 1-tile margin
    cells = 8
    margin = size * 0.13 + pad
    inner = size - 2 * margin
    cell = inner / cells

    nxt = rng(20260910)
    tiles = [[(nxt() >> 8) % 4 for _ in range(cells)] for _ in range(cells)]

    # three corner anchors, like the real format (TL, TR, BL)
    anchors = {(0, 0), (0, cells - 1), (cells - 1, 0)}

    for y in range(size):
        for x in range(size):
            i = (y * size + x) * 4
            fx, fy = x + 0.5, y + 0.5

            # rounded-rect coverage
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

            # tile body, with a small gutter between tiles
            ox = (fx - margin) - gx * cell
            oy = (fy - margin) - gy * cell
            gutter = cell * 0.14
            if ox < gutter or oy < gutter or ox > cell - gutter or oy > cell - gutter:
                continue

            if (gx, gy) in anchors:
                # solid anchor block
                px[i], px[i + 1], px[i + 2] = ANCHOR
                continue

            # stipple the tile into a 4x4 sub-cell pattern so it reads as a
            # data tile rather than a flat swatch
            v = tiles[gx][gy]
            sx = int((ox - gutter) / ((cell - 2 * gutter) / 4))
            sy = int((oy - gutter) / ((cell - 2 * gutter) / 4))
            sx = max(0, min(3, sx))
            sy = max(0, min(3, sy))
            on = ((v + sx * 3 + sy * 5) % 4) < 2
            if not on:
                continue

            r, g, b = PALETTE[v]
            px[i], px[i + 1], px[i + 2] = r, g, b

    return px


def main():
    os.makedirs(OUT, exist_ok=True)

    def save(name, size, rounded, inset):
        write_png(os.path.join(OUT, name), size, size, render(size, rounded, inset))
        print('wrote', name, f'{size}x{size}')

    save('icon-192.png', 192, rounded=True, inset=0.0)
    save('icon-512.png', 512, rounded=True, inset=0.0)
    save('icon-maskable-512.png', 512, rounded=False, inset=0.10)
    # iOS masks its own corners, so ship an opaque square
    save('apple-touch-icon.png', 180, rounded=False, inset=0.06)

    # ---- native app icon (Xcode asset catalog) ----
    # Apple rejects app icons with an alpha channel, hence alpha=False.
    # OUT is <repo>/app/icons, so the repo root is two levels up
    repo_root = os.path.dirname(os.path.dirname(OUT))
    native_set = os.path.join(repo_root, 'native', 'AirCimbar',
                              'Assets.xcassets', 'AppIcon.appiconset')
    os.makedirs(native_set, exist_ok=True)
    write_png(os.path.join(native_set, 'icon-1024.png'), 1024, 1024,
              render(1024, rounded=False, inset=0.06), alpha=False)
    print('wrote native app icon 1024x1024 (opaque RGB)')


if __name__ == '__main__':
    main()
