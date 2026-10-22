"""生成扩展图标（纯标准库，不依赖 Pillow）。

做法：在 4 倍尺寸上按距离场画圆角矩形，再 4x4 盒式降采样拿到抗锯齿。
输出 extension/icons/icon{16,32,48,128}.png

用法: python tools/make_icons.py
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"
SS = 4  # 超采样倍数

# 品牌色：与台账里「域名」类别的蓝 → 仓库类的紫，做个斜向渐变
C1 = (10, 132, 255)
C2 = (110, 92, 246)


def in_rrect(x: float, y: float, w: float, h: float, r: float) -> bool:
    """点 (x,y) 是否落在左上角为原点、宽 w 高 h、圆角 r 的矩形内。"""
    if x < 0 or y < 0 or x > w or y > h:
        return False
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def write_png(path: Path, w: int, h: int, rgba: bytearray) -> None:
    raw = b"".join(b"\x00" + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def render(size: int) -> bytearray:
    big = size * SS
    canvas = bytearray(big * big * 4)

    pad = big * 0.055          # 四周留白，避免图标贴边
    box = big - pad * 2
    radius = box * 0.225

    # 三条"台账横条"（相对整图的比例，16px 小图标也放得下）
    bars = [
        (0.245, 0.285, 0.735, 0.085),
        (0.245, 0.445, 0.640, 0.085),
        (0.245, 0.605, 0.545, 0.085),
    ]

    for py in range(big):
        for px in range(big):
            i = (py * big + px) * 4
            # 底：圆角方块 + 斜向渐变
            if not in_rrect(px - pad, py - pad, box, box, radius):
                continue
            t = (px + py) / (2.0 * big)
            r = int(C1[0] + (C2[0] - C1[0]) * t)
            g = int(C1[1] + (C2[1] - C1[1]) * t)
            b = int(C1[2] + (C2[2] - C1[2]) * t)
            a = 255

            # 前：三条白色圆角横条，靠上位置更亮一点，做出层次
            for row, (x0, y0, x1, hh) in enumerate(bars):
                bx = big * x0
                by = big * y0
                bw = big * (x1 - x0)
                bh = big * hh
                if in_rrect(px - bx, py - by, bw, bh, bh * 0.5):
                    alpha = 0.97 - row * 0.14
                    r = int(r + (255 - r) * alpha)
                    g = int(g + (255 - g) * alpha)
                    b = int(b + (255 - b) * alpha)
                    break

            canvas[i:i + 4] = bytes((r, g, b, a))

    # 盒式降采样 → 抗锯齿
    out = bytearray(size * size * 4)
    n = SS * SS
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for dy in range(SS):
                for dx in range(SS):
                    j = ((y * SS + dy) * big + (x * SS + dx)) * 4
                    for k in range(4):
                        acc[k] += canvas[j + k]
            o = (y * size + x) * 4
            out[o:o + 4] = bytes(v // n for v in acc)
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = OUT_DIR / f"icon{size}.png"
        write_png(path, size, size, render(size))
        print(f"  {path.name:12s} {path.stat().st_size:>6d} B")


if __name__ == "__main__":
    main()
