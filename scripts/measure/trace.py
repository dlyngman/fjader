# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Chrome performance traces: where main-thread and GPU-process time went, per session phase.

    uv run scripts/measure/trace.py ~/Downloads/Trace-20261120T101500.json.gz
    uv run scripts/measure/trace.py main=Trace-a.json.gz branch=Trace-b.json.gz --window brush

Reads a trace saved from DevTools → Performance (.json or .json.gz). Splits it into windows by the
test pages' User Timing marks: `fjader:phase:<name>` starts a phase, which runs to the next phase
mark or `fjader:end:*`; `fjader:drag:start` / `fjader:drag:end` bound a drag. A trace without
fjader marks is one window, `all`.

Per window and trace:
- busy: the page's main thread (CrRendererMain), the sum of its top-level tasks
- gc:   self time of garbage-collection events on it (MinorGC, MajorGC, V8.GC_*, CppGC.*)
- gpu:  the GPU process's main thread (CrGpuMain), the sum of its top-level tasks

Then the event names with the most self time on the page's main thread in one window
(--window, default the window busiest in the first trace), one column per trace. Self time is an
event's duration minus its children's, so nested events (RunTask > FunctionCall > MinorGC) are not
counted twice. Recording a trace costs time itself: compare traces with traces, not with logs.

With --functions, also the JavaScript functions with the most time in that window, from the
trace's CPU profile (samples about every 0.1 to 1 ms): `self` is time in the function's own
code, `total` includes what it called, each with its share of the window's sampled time that
was not idle. `--match PATTERN` keeps only functions whose name or file matches (`--match
'lod/|lifecycle'`), and implies --functions. A production build's names are minified: record on
the dev server to read them, and compare shares there, not milliseconds.

See docs/measuring.md.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

GC = re.compile(r'GC|Scavenge')


def load(path: Path) -> list[dict]:
    opener = gzip.open if path.suffix == '.gz' else open
    with opener(path, 'rt') as f:
        data = json.load(f)
    return data['traceEvents'] if isinstance(data, dict) else data


class Trace:
    def __init__(self, events: list[dict]):
        names: dict[tuple[int, int], str] = {}
        for e in events:
            if e.get('ph') == 'M' and e.get('name') == 'thread_name':
                names[(e['pid'], e['tid'])] = e['args']['name']
        marks = sorted(
            (e['ts'], e['name'], (e['pid'], e['tid']))
            for e in events
            if isinstance(e.get('name'), str) and e['name'].startswith('fjader:') and 'ts' in e
        )
        complete: dict[tuple[int, int], list[dict]] = defaultdict(list)
        for e in events:
            if e.get('ph') == 'X' and 'dur' in e:
                complete[(e['pid'], e['tid'])].append(e)

        def busiest(thread_name: str) -> tuple[int, int] | None:
            candidates = [k for k, v in names.items() if v == thread_name and k in complete]
            return max(candidates, key=lambda k: sum(e['dur'] for e in complete[k]), default=None)

        # The page's main thread: where the marks were made, else the busiest renderer.
        self.main = marks[0][2] if marks else busiest('CrRendererMain')
        self.gpu = busiest('CrGpuMain')
        self.windows = self._windows(marks, complete.get(self.main, []))
        self.main_events = self._with_self_time(complete.get(self.main, []))
        self.gpu_events = self._with_self_time(complete.get(self.gpu, [])) if self.gpu else []
        self._profile(events)

    @staticmethod
    def _windows(marks: list, main_events: list[dict]) -> list[tuple[str, float, float]]:
        end_of_trace = max((e['ts'] + e['dur'] for e in main_events), default=0.0)
        windows: list[tuple[str, float, float]] = []
        open_phase: tuple[str, float] | None = None
        drag_start: float | None = None
        for ts, name, _ in marks:
            _, kind, label = (name.split(':', 2) + ['', ''])[:3]
            if kind in ('phase', 'end') and open_phase:
                windows.append((open_phase[0], open_phase[1], ts))
                open_phase = None
            if kind == 'phase':
                open_phase = (label, ts)
            elif kind == 'drag' and label == 'start':
                drag_start = ts
            elif kind == 'drag' and label == 'end' and drag_start is not None:
                windows.append(('drag', drag_start, ts))
                drag_start = None
        if open_phase:
            windows.append((open_phase[0], open_phase[1], end_of_trace))
        if not windows:
            start = min((e['ts'] for e in main_events), default=0.0)
            windows.append(('all', start, end_of_trace))
        return windows

    @staticmethod
    def _with_self_time(events: list[dict]) -> list[tuple[float, float, float, str, int]]:
        """(start, dur, self, name, depth) per event; events on one thread nest."""
        ordered = sorted(events, key=lambda e: (e['ts'], -e['dur']))
        out: list[list] = []
        stack: list[int] = []
        for e in ordered:
            start, dur = e['ts'], e['dur']
            while stack and out[stack[-1]][0] + out[stack[-1]][1] <= start:
                stack.pop()
            if stack:
                out[stack[-1]][2] -= dur
            out.append([start, dur, dur, e['name'], len(stack)])
            stack.append(len(out) - 1)
        return [tuple(x) for x in out]

    def summary(self, window: tuple[str, float, float]) -> dict[str, float]:
        _, a, b = window
        busy = sum(d for s, d, _, _, depth in self.main_events if depth == 0 and a <= s < b)
        gc = sum(own for s, _, own, n, _ in self.main_events if a <= s < b and GC.search(n))
        gpu = sum(d for s, d, _, _, depth in self.gpu_events if depth == 0 and a <= s < b)
        return {'busy': busy / 1000, 'gc': gc / 1000, 'gpu': gpu / 1000, 'span': (b - a) / 1000}

    def function_times(
        self, window: tuple[str, float, float]
    ) -> tuple[dict[str, list[float]], float]:
        """[self ms, total ms] per JavaScript function on the page's main thread, in the window,
        and the window's sampled time that was not idle, ms (what a share is of)."""
        _, a, b = window
        totals: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
        busy = 0.0
        for at, dur, node in self.samples:
            if not (a <= at < b):
                continue
            if node not in self.idle:
                busy += dur / 1000
            seen: set[str] = set()
            own = True
            while node is not None:
                label = self.functions.get(node)
                if label is not None:
                    if own:
                        totals[label][0] += dur / 1000
                    if label not in seen:
                        seen.add(label)
                        totals[label][1] += dur / 1000
                own = False
                node = self.parents.get(node)
        return totals, busy

    def _profile(self, events: list[dict]) -> None:
        """The main thread's CPU profiles: their samples as (time, duration, node), and the call
        tree. Every profile on the thread is read (a profiler restart, a reload); node ids are
        per profile, so a node is keyed by (profile id, node id)."""
        self.samples: list[tuple[float, float, tuple]] = []
        self.parents: dict[tuple, tuple | None] = {}
        self.functions: dict[tuple, str | None] = {}
        self.idle: set[tuple] = set()
        profiles = [
            e
            for e in events
            if e.get('name') == 'Profile' and (e.get('pid'), e.get('tid')) == self.main
        ]
        for profile in profiles:
            pid = profile['id']
            chunks = sorted(
                (
                    e
                    for e in events
                    if e.get('name') == 'ProfileChunk'
                    and e.get('pid') == profile['pid']
                    and e.get('id') == pid
                ),
                key=lambda e: e['ts'],
            )
            at = float(profile['args']['data']['startTime'])
            timed: list[tuple[float, tuple]] = []
            for chunk in chunks:
                data = chunk['args']['data']
                for node in data.get('cpuProfile', {}).get('nodes', []):
                    key = (pid, node['id'])
                    frame = node.get('callFrame', {})
                    name = frame.get('functionName') or '(anonymous)'
                    parent = node.get('parent')
                    self.parents[key] = (pid, parent) if parent is not None else None
                    # The profiler's own rows are not functions of the page.
                    if name in ('(root)', '(idle)', '(program)'):
                        self.functions[key] = None
                        if name == '(idle)':
                            self.idle.add(key)
                        continue
                    url = frame.get('url') or ''
                    file = url.split('?')[0].rsplit('/', 2)[-2:] if url else []
                    # Line and column: a minified bundle has most functions on line 1.
                    where = (
                        f" ({'/'.join(file)}:{frame.get('lineNumber', 0) + 1}"
                        f":{frame.get('columnNumber', 0) + 1})"
                        if file
                        else ''
                    )
                    self.functions[key] = name + where
                for node, delta in zip(
                    data.get('cpuProfile', {}).get('samples', []), data.get('timeDeltas', [])
                ):
                    at += delta
                    timed.append((at, (pid, node)))
            # Deltas can be negative: samples in time order, as DevTools reads them.
            timed.sort(key=lambda t: t[0])
            # A sample stands for the time until the next one of its profile.
            for i, (t, node) in enumerate(timed):
                dur = timed[i + 1][0] - t if i + 1 < len(timed) else 0.0
                self.samples.append((t, dur, node))

    def self_times(self, window: tuple[str, float, float]) -> dict[str, float]:
        _, a, b = window
        totals: dict[str, float] = defaultdict(float)
        for s, _, own, name, _ in self.main_events:
            if a <= s < b:
                totals[name] += own / 1000
        return totals


def merged(trace: Trace) -> dict[str, list[tuple[str, float, float]]]:
    """Windows by name (a phase that recurs is all its windows)."""
    out: dict[str, list] = defaultdict(list)
    for w in trace.windows:
        out[w[0]].append(w)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('traces', nargs='+', help='trace files, or label=file')
    parser.add_argument('--window', help='the window for the self-time table (default: the busiest)')
    parser.add_argument('--top', type=int, default=15, help='event names to show (default 15)')
    parser.add_argument(
        '--functions',
        action='store_true',
        help='also JavaScript functions by self and total time, from the CPU profile',
    )
    parser.add_argument(
        '--match',
        metavar='PATTERN',
        help='only functions whose name or file matches this regex (implies --functions)',
    )
    args = parser.parse_args()
    keep = None
    if args.match is not None:
        try:
            keep = re.compile(args.match)
        except re.error as e:
            parser.error(f'--match: not a regular expression: {e}')

    traces: dict[str, Trace] = {}
    for arg in args.traces:
        label, sep, path = arg.partition('=')
        if not sep or not Path(path).expanduser().exists():
            label, path = '', arg
        p = Path(path).expanduser()
        traces[label or p.name.split('.')[0]] = Trace(load(p))

    labels = list(traces)
    windows = {label: merged(t) for label, t in traces.items()}
    order: list[str] = []
    for label in labels:
        for name in windows[label]:
            if name not in order:
                order.append(name)

    def total(label: str, name: str) -> dict[str, float]:
        acc = {'busy': 0.0, 'gc': 0.0, 'gpu': 0.0, 'span': 0.0}
        for w in windows[label].get(name, []):
            for k, v in traces[label].summary(w).items():
                acc[k] += v
        return acc

    print(
        'Per window, ms: page main thread busy / of which GC / GPU process main thread busy (window length)\n'
    )
    print('| window | ' + ' | '.join(labels) + ' |')
    print('|---|' + '---|' * len(labels))
    for name in order:
        cells = []
        for label in labels:
            if name not in windows[label]:
                cells.append('–')
                continue
            t = total(label, name)
            cells.append(f'{t["busy"]:.0f} / {t["gc"]:.0f} / {t["gpu"]:.0f} ({t["span"]:.0f})')
        print(f'| {name} | ' + ' | '.join(cells) + ' |')

    focus = args.window or max(order, key=lambda n: total(labels[0], n)['busy'])
    print(f'\nSelf time on the page main thread in `{focus}`, ms (top {args.top}):\n')
    per_label = {}
    for label in labels:
        acc: dict[str, float] = defaultdict(float)
        for w in windows[label].get(focus, []):
            for n, v in traces[label].self_times(w).items():
                acc[n] += v
        per_label[label] = acc
    names = sorted(
        {n for acc in per_label.values() for n in acc},
        key=lambda n: -max(acc.get(n, 0.0) for acc in per_label.values()),
    )
    print('| event | ' + ' | '.join(labels) + ' |')
    print('|---|' + '---|' * len(labels))
    for n in names[: args.top]:
        print(f'| {n} | ' + ' | '.join(f'{per_label[label].get(n, 0.0):.1f}' for label in labels) + ' |')

    if args.functions or keep is not None:
        per_fn: dict[str, dict[str, list[float]]] = {}
        busy: dict[str, float] = {}
        for label in labels:
            acc: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
            busy[label] = 0.0
            for w in windows[label].get(focus, []):
                times, sampled = traces[label].function_times(w)
                busy[label] += sampled
                for n, (own, whole) in times.items():
                    if keep is None or keep.search(n):
                        acc[n][0] += own
                        acc[n][1] += whole
            per_fn[label] = acc
        if not any(busy.values()):
            print('\nNo CPU profile samples for the page main thread in this window.')
            return 0
        if not any(per_fn.values()):
            if keep is not None:
                print(f'\nNo function in `{focus}` matches `{args.match}`.')
            else:
                print(f'\nNo JavaScript function in the CPU profile samples of `{focus}`.')
            return 0

        def cell(label: str, n: str, column: int) -> str:
            ms = per_fn[label][n][column] if n in per_fn[label] else 0.0
            share = 100 * ms / busy[label] if busy[label] else 0.0
            return f'{ms:.1f} ({share:.1f} %)'

        matching = f', matching `{args.match}`' if keep is not None else ''
        for column, title in ((0, 'self'), (1, 'total (with what it called)')):
            fns = sorted(
                {n for acc in per_fn.values() for n in acc},
                key=lambda n: -max(acc[n][column] if n in acc else 0.0 for acc in per_fn.values()),
            )
            print(
                f'\nJavaScript functions in `{focus}` by {title} time, ms (share of sampled time '
                f'not idle; top {args.top}{matching}):\n'
            )
            print('| function | ' + ' | '.join(labels) + ' |')
            print('|---|' + '---|' * len(labels))
            for n in fns[: args.top]:
                print(f'| {n} | ' + ' | '.join(cell(label, n, column) for label in labels) + ' |')
    return 0


if __name__ == '__main__':
    sys.exit(main())
