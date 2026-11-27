# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Compare two capture files from /test/path-grid?capture=1: are the same pixels drawn?

    uv run scripts/measure/captures.py ~/Downloads/captures-pathgrid.json "~/Downloads/captures-pathgrid (1).json"
    uv run scripts/measure/captures.py main=a.json branch=b.json --out /tmp/diffs

A capture file holds, for each state of the page's scripted sequence and each canvas of each
case, the pixels the chart came to rest at. This pairs the two files' captures by (state, case,
canvas) and says which are the same pixel for pixel. For one that differs: how many pixels, the
largest difference in one channel, and the box they lie in. With --out, a PNG per differing
capture: the first file's pixels, the second's, and the differing pixels in red, side by side.

Two runs of ONE build come first: captures that differ between them are not stable (a readback
taken mid-travel, a chart whose text or timing varies) and cannot say anything about a change.
`--tolerance N` passes a capture whose channels differ by at most N.

Compare runs of the same window size and display: the file records them and this warns.
Exit status 1 when any capture differs, is missing, was not drawn in either run, or never came to
rest.

See docs/measuring.md.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import struct
import sys
import zlib
from pathlib import Path


def load(path: Path) -> dict:
    with path.open() as f:
        return json.load(f)


def keyed(log: dict) -> dict[tuple[str, str, int], dict]:
    return {(c['state'], c['case'], c['index']): c for c in log['captures']}


def pixels(capture: dict) -> bytes | None:
    return gzip.decompress(base64.b64decode(capture['pixels'])) if capture.get('pixels') else None


def difference(a: bytes, b: bytes, width: int, tolerance: int):
    """(differing pixels, largest channel difference, bounding box, per-pixel flags) or None."""
    count = 0
    largest = 0
    x0, y0, x1, y1 = width, len(a) // 4 // width, -1, -1
    flags = bytearray(len(a) // 4)
    row = width * 4
    for y in range(len(a) // row):
        ra = a[y * row : (y + 1) * row]
        rb = b[y * row : (y + 1) * row]
        if ra == rb:
            continue
        for x in range(width):
            pa = ra[x * 4 : x * 4 + 4]
            pb = rb[x * 4 : x * 4 + 4]
            if pa == pb:
                continue
            d = max(abs(pa[k] - pb[k]) for k in range(4))
            if d <= tolerance:
                continue
            count += 1
            largest = max(largest, d)
            flags[y * width + x] = 1
            x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
    return (count, largest, (x0, y0, x1, y1), flags) if count else None


def write_png(path: Path, width: int, height: int, rgba: bytes) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    rows = b''.join(b'\x00' + rgba[y * width * 4 : (y + 1) * width * 4] for y in range(height))
    path.write_bytes(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(rows, 6))
        + chunk(b'IEND', b'')
    )


def on_white(raw: bytes, bgra: bool) -> bytearray:
    """The capture as opaque RGBA over white (the canvas is premultiplied)."""
    out = bytearray(len(raw))
    for i in range(0, len(raw), 4):
        b, g, r, a = (raw[i], raw[i + 1], raw[i + 2], raw[i + 3]) if bgra else (raw[i + 2], raw[i + 1], raw[i], raw[i + 3])
        out[i] = min(255, r + 255 - a)
        out[i + 1] = min(255, g + 255 - a)
        out[i + 2] = min(255, b + 255 - a)
        out[i + 3] = 255
    return out


def side_by_side(a: bytes, b: bytes, flags: bytearray, width: int, height: int, bgra: bool) -> tuple[int, bytes]:
    left, right = on_white(a, bgra), on_white(b, bgra)
    marked = bytearray(right)
    for i, flag in enumerate(flags):
        if flag:
            marked[i * 4 : i * 4 + 4] = b'\xff\x00\x00\xff'
    out = bytearray()
    for y in range(height):
        s = slice(y * width * 4, (y + 1) * width * 4)
        out += left[s] + right[s] + marked[s]
    return width * 3, bytes(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('a', help='the first capture file, or label=file')
    parser.add_argument('b', help='the second')
    parser.add_argument('--out', type=Path, help='a directory for a PNG per differing capture')
    parser.add_argument('--tolerance', type=int, default=0, help='largest channel difference that passes (default 0)')
    args = parser.parse_args()

    logs = []
    labels = []
    for n, arg in enumerate((args.a, args.b)):
        label, sep, path = arg.partition('=')
        if not sep or not Path(path).expanduser().exists():
            label, path = 'ab'[n], arg
        labels.append(label)
        logs.append(load(Path(path).expanduser()))
    a, b = (keyed(log) for log in logs)

    for field in ('viewport', 'format'):
        if logs[0].get(field) != logs[1].get(field):
            print(f'Warning: the runs differ in {field}: {logs[0].get(field)} against {logs[1].get(field)}', file=sys.stderr)
    bgra = str(logs[0].get('format', '')).startswith('bgra')

    same = 0
    rows: list[str] = []
    unsettled: list[str] = []
    for key in sorted(set(a) | set(b)):
        name = f'{key[0]} | {key[1]} | {key[2]}'
        ca, cb = a.get(key), b.get(key)
        if ca is None or cb is None:
            rows.append(f'| {name} | only in {labels[0] if cb is None else labels[1]} | | |')
            continue
        for label, c in zip(labels, (ca, cb)):
            if not c.get('settled'):
                unsettled.append(f'{name} ({label})')
        # A canvas that drew in neither run has no pixels and an equal (absent) hash: not a match.
        if ca.get('pixels') is None and cb.get('pixels') is None:
            rows.append(f'| {name} | not drawn in either | | |')
            continue
        if ca['hash'] == cb['hash'] and (ca['width'], ca['height']) == (cb['width'], cb['height']):
            same += 1
            continue
        if (ca['width'], ca['height']) != (cb['width'], cb['height']):
            rows.append(f'| {name} | size {ca["width"]}×{ca["height"]} against {cb["width"]}×{cb["height"]} | | |')
            continue
        pa, pb = pixels(ca), pixels(cb)
        if pa is None or pb is None:
            rows.append(f'| {name} | not drawn in {labels[0] if pa is None else labels[1]} | | |')
            continue
        found = difference(pa, pb, ca['width'], args.tolerance)
        if found is None:
            same += 1
            continue
        count, largest, (x0, y0, x1, y1), flags = found
        rows.append(f'| {name} | {count} | {largest} | {x0},{y0} to {x1},{y1} |')
        if args.out:
            args.out.mkdir(parents=True, exist_ok=True)
            w, data = side_by_side(pa, pb, flags, ca['width'], ca['height'], bgra)
            safe = ''.join(ch if ch.isalnum() else '-' for ch in f'{key[0]}-{key[1][:24]}-{key[2]}')
            write_png(args.out / f'{safe}.png', w, ca['height'], data)

    print(f'{same} captures the same, {len(rows)} not, of {len(set(a) | set(b))}.')
    if unsettled:
        print(f'\nNot at rest when captured ({len(unsettled)}): two readbacks in a row never agreed.')
        for name in unsettled:
            print(f'  {name}')
    if rows:
        print('\n| state | case | canvas | differing pixels | largest channel difference | box |')
        print('|---|---|---|---|---|---|')
        for row in rows:
            print(row)
        if args.out:
            print(f'\nPNGs in {args.out}: {labels[0]}, {labels[1]}, and the differing pixels in red.')
    return 1 if rows or unsettled else 0


if __name__ == '__main__':
    sys.exit(main())
