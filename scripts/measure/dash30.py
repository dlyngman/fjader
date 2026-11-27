# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Compare /test/dashboard-30 runs: per phase, the median over runs of each variant.

    uv run scripts/measure/dash30.py ~/Downloads/dash30-attached-axes*.json ~/Downloads/dash30-textmark-axes*.json

Runs are grouped by the log's `variant` (the page's ?labels and ?axes), or by a label you give:
`main=path.json` and `branch=path.json` (repeat a label for its runs). Uses the per-phase summary
the page computed (frame-probe.ts `summarize`), plus each phase's total main-thread work from the
per-frame records. Prints a Markdown table per metric: one row per phase, one column per variant,
each cell the median over that variant's runs, with the runs' range when there are several.

With --created, also the WebGPU objects the page made (the probe's `created`), a table per
variant: one row per phase, one column per kind, each cell the median frame's count and the
phase's total (medians over the variant's runs). What a phase makes on every frame is what
Blink's garbage collector later sweeps.

See docs/measuring.md.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

# Metric name -> (column in the page's summary, or a computed one; heading).
METRICS: dict[str, str] = {
    'workTotal': 'main-thread work, total (ms)',
    'workP50': 'main-thread work per frame, p50 (ms)',
    'workP95': 'main-thread work per frame, p95 (ms)',
    'droppedPct': 'dropped frames (%)',
    'gpuP50': 'GPU time per submit, p50 (ms)',
    'passMsP50': 'GPU pass time per submit, p50 (ms)',
    'elementDraws': 'text atlas uploads',
}
DEFAULT = ['workTotal', 'workP50', 'workP95', 'droppedPct', 'gpuP50']


def load(path: Path) -> dict:
    with path.open() as f:
        return json.load(f)


def phase_rows(log: dict) -> dict[str, dict[str, float | None]]:
    """Per phase: the page's summary row, plus workTotal from the frames."""
    rows = {row['phase']: dict(row) for row in log['summary']['phases']}
    probe = log.get('probe') or {}
    names = probe.get('phases') or []
    frames = probe.get('frames') or {}
    work = frames.get('work') or []
    phase = frames.get('phase') or []
    totals: dict[str, float] = {}
    # Frame 0 has no interval and is left out of the page's summary too.
    for i in range(1, min(len(work), len(phase))):
        w = work[i]
        if w is None or w != w:
            continue
        name = names[phase[i]] if phase[i] < len(names) else str(phase[i])
        totals[name] = totals.get(name, 0.0) + w
    for name, row in rows.items():
        row['workTotal'] = totals.get(name)
    return rows


def fmt(values: list[float]) -> str:
    if not values:
        return '–'
    m = statistics.median(values)
    digits = 1 if abs(m) >= 10 else 2
    cell = f'{m:.{digits}f}'
    if len(values) > 1:
        cell += f' ({min(values):.{digits}f}–{max(values):.{digits}f})'
    return cell


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('runs', nargs='+', help='log files, or label=file')
    parser.add_argument(
        '--metrics',
        default=','.join(DEFAULT),
        help=f'comma-separated, from: {", ".join(METRICS)} (default: {",".join(DEFAULT)})',
    )
    parser.add_argument(
        '--created', action='store_true', help='also WebGPU objects made per frame, by kind'
    )
    args = parser.parse_args()
    metrics = [m.strip() for m in args.metrics.split(',') if m.strip()]
    unknown = [m for m in metrics if m not in METRICS]
    if unknown:
        parser.error(f'unknown metric(s): {", ".join(unknown)}')

    groups: dict[str, list[dict[str, dict]]] = {}
    phases: list[str] = []
    meta: dict[str, set[str]] = {}
    for arg in args.runs:
        label, sep, path = arg.partition('=')
        if not sep or not Path(path).expanduser().exists():
            label, path = '', arg
        log = load(Path(path).expanduser())
        label = label or log.get('variant') or Path(path).stem
        rows = phase_rows(log)
        groups.setdefault(label, []).append(rows)
        for name in rows:
            if name not in phases:
                phases.append(name)
        vp = log.get('viewport') or {}
        size = f'{vp.get("w")}×{vp.get("h")} @{round(vp.get("dpr") or 0, 2)}x'
        cadence = log['summary'].get('cadence', 0)
        meta.setdefault(label, set()).add(f'{size}, cadence {cadence:.2f} ms')

    labels = list(groups)
    print('Runs: ' + ', '.join(f'{label} ×{len(groups[label])}' for label in labels))
    for label in labels:
        if len(meta[label]) > 1:
            print(
                f'Warning: {label} runs differ in viewport or cadence: {sorted(meta[label])}', file=sys.stderr
            )
        print(f'  {label}: {", ".join(sorted(meta[label]))}')
    for metric in metrics:
        print(f'\n### {METRICS[metric]}\n')
        print('| phase | ' + ' | '.join(labels) + ' |')
        print('|---|' + '---|' * len(labels))
        for name in phases:
            cells = []
            for label in labels:
                values = [
                    float(rows[name][metric])
                    for rows in groups[label]
                    if name in rows and rows[name].get(metric) is not None
                ]
                cells.append(fmt(values))
            print(f'| {name} | ' + ' | '.join(cells) + ' |')

    if args.created:
        for label in labels:
            kinds: list[str] = []
            for rows in groups[label]:
                for row in rows.values():
                    for kind in row.get('created') or {}:
                        if kind not in kinds:
                            kinds.append(kind)
            if not kinds:
                print(f'\n{label}: no `created` counts in these logs (saved before the probe had them).')
                continue
            print(f'\n### WebGPU objects made, {label}: median frame (phase total)\n')
            print('| phase | ' + ' | '.join(kinds) + ' |')
            print('|---|' + '---|' * len(kinds))
            for name in phases:
                cells = []
                for kind in kinds:
                    made = [
                        rows[name]['created'][kind]
                        for rows in groups[label]
                        if name in rows and kind in (rows[name].get('created') or {})
                    ]
                    if not made:
                        cells.append('–')
                        continue
                    p50 = statistics.median(m['p50'] for m in made)
                    total = statistics.median(m['total'] for m in made)
                    cells.append(f'{p50:g} ({total:g})')
                print(f'| {name} | ' + ' | '.join(cells) + ' |')
    return 0


if __name__ == '__main__':
    sys.exit(main())
