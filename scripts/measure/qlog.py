# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Statement logs (qlog-*, clog-*, rebin-*, dash30-*): work and queue wait per statement group.

    uv run scripts/measure/qlog.py ~/Downloads/qlog-all.json ~/Downloads/qlog-all*.json
    uv run scripts/measure/qlog.py main=a.json main=b.json branch=c.json --window drag

The same model as the page's report() (query-engine/debug/query-log.ts): each connection serves
its statements first in, first out, so a statement starts at the later of when it was sent and
when the previous statement on its connection finished. `wait` is that delay, `work` the rest.
Times are main-thread times: they read high while the main thread is busy.

Runs are grouped by label: `label=file`, or the file name without its " (n)" download suffix.
Each group's numbers are the median over its runs.

--window drag     only statements sent during the log's scripted drag (/test/query-load)
--window A:B      only statements sent between A and B ms (performance.now() time)
--by FIELDS       the group key, from connection,class,purpose,table,source,caller
                  (default connection,class,purpose,table, as report())
--raw             keep table names as logged; by default the per-run parts (preagg hashes,
                  view and dim ids) become `*`, so one table's statements group across runs

See docs/measuring.md.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from pathlib import Path


def normalize(name: str) -> str:
    """A table name without its per-run parts: preagg hashes, view and dim ids."""
    name = re.sub(r'__dplot_preagg_[0-9a-f]+', '__dplot_preagg_*', name)
    # Generated ids: 7 lowercase letters and digits with at least one digit (sx2klhy).
    return re.sub(r'_(?=[a-z]*\d)[a-z0-9]{7}(?=_|$)', '_*', name)


def label_of(path: Path) -> str:
    return re.sub(r' \(\d+\)$', '', path.stem)


def window_of(log: dict, spec: str | None) -> tuple[float, float] | None:
    if not spec:
        return None
    if spec == 'drag':
        drag = log.get('drag')
        if not drag:
            raise SystemExit('--window drag: this log has no `drag` (only /test/query-load records one)')
        return float(drag['start']), float(drag['end'])
    a, sep, b = spec.partition(':')
    if not sep:
        raise SystemExit(f'--window: expected drag or A:B, got {spec!r}')
    return float(a), float(b)


def analyse(log: dict, by: list[str], window: tuple[float, float] | None, raw: bool) -> dict:
    statements = sorted(log.get('statements') or [], key=lambda s: s['start'])
    last_end = {'main': 0.0, 'lane': 0.0}
    groups: dict[str, dict[str, float]] = {}
    total_work = total_wait = 0.0
    first = last = None
    n = 0
    for s in statements:
        conn = s.get('connection') or 'main'
        start = max(s['start'], last_end.get(conn, 0.0))
        last_end[conn] = max(last_end.get(conn, 0.0), s['end'])
        if window and not (window[0] <= s['start'] <= window[1]):
            continue
        work = s['end'] - start
        wait = start - s['start']
        parts = []
        for field in by:
            value = str(s.get(field) or ('main' if field == 'connection' else '?'))
            parts.append(value if raw or field not in ('table', 'source') else normalize(value))
        key = ' '.join(parts)
        g = groups.setdefault(key, {'n': 0, 'work': 0.0, 'wait': 0.0})
        g['n'] += 1
        g['work'] += work
        g['wait'] += wait
        total_work += work
        total_wait += wait
        first = s['start'] if first is None else first
        last = s['end'] if last is None else max(last, s['end'])
        n += 1
    return {
        'n': n,
        'span': (last - first) if n else 0.0,
        'work': total_work,
        'wait': total_wait,
        'groups': groups,
    }


def med(values: list[float]) -> float:
    return statistics.median(values) if values else 0.0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('runs', nargs='+', help='log files, or label=file')
    parser.add_argument('--window', help='drag, or A:B in ms')
    parser.add_argument('--by', default='connection,class,purpose,table')
    parser.add_argument('--top', type=int, default=15, help='groups to show, by work (default 15)')
    parser.add_argument('--raw', action='store_true', help='keep table names as logged')
    args = parser.parse_args()
    by = [f.strip() for f in args.by.split(',') if f.strip()]

    runs: dict[str, list[dict]] = {}
    for arg in args.runs:
        label, sep, path = arg.partition('=')
        if not sep or not Path(path).expanduser().exists():
            label, path = '', arg
        p = Path(path).expanduser()
        with p.open() as f:
            log = json.load(f)
        runs.setdefault(label or label_of(p), []).append(
            analyse(log, by, window_of(log, args.window), args.raw)
        )

    labels = list(runs)
    print('Runs: ' + ', '.join(f'{label} ×{len(runs[label])}' for label in labels))
    if args.window:
        print(f'Window: {args.window}')
    print('\n| | ' + ' | '.join(labels) + ' |')
    print('|---|' + '---|' * len(labels))
    for key, heading in [
        ('n', 'statements'),
        ('span', 'span (ms)'),
        ('work', 'work (ms)'),
        ('wait', 'queue wait (ms)'),
    ]:
        cells = [f'{med([r[key] for r in runs[label]]):.0f}' for label in labels]
        print(f'| {heading} | ' + ' | '.join(cells) + ' |')

    # Groups, ranked by the largest median work across labels.
    keys = {k for label in labels for r in runs[label] for k in r['groups']}

    def group_med(label: str, key: str, field: str) -> float:
        return med([r['groups'].get(key, {}).get(field, 0.0) for r in runs[label]])

    ranked = sorted(keys, key=lambda k: -max(group_med(label, k, 'work') for label in labels))
    print(f'\nGroups ({" ".join(by)}), median work / wait in ms, statements:\n')
    print('| group | ' + ' | '.join(labels) + ' |')
    print('|---|' + '---|' * len(labels))
    for key in ranked[: args.top]:
        cells = []
        for label in labels:
            work, wait = group_med(label, key, 'work'), group_med(label, key, 'wait')
            cells.append(f'{work:.1f} / {wait:.1f}, ×{group_med(label, key, "n"):.0f}')
        print(f'| {key} | ' + ' | '.join(cells) + ' |')
    if len(ranked) > args.top:
        print(f'\n({len(ranked) - args.top} more groups; --top N to show them)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
