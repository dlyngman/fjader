# Measuring performance

How fjader's performance is measured: on test pages with built-in instruments, driven by
scripted interactions, with logs and traces saved as files and analysed offline. The same
method serves a person at the keyboard and a coding agent that can only read files.

## Principles

- **Measure, don't reason.** A performance fix starts from a measurement, not from reading the
  code. When a first guess about a cause turns out wrong, instrument before guessing again.
- **Pick the metric the change can move.** A change to query order shows in when charts enter
  (their spread), not in total time; a change to per-frame work shows in main-thread time per
  frame while data animates, not at rest.
- **Same workload, every run.** Interactions are scripted (below), never drawn by hand: two hand
  drags differ more than most changes do.
- **Medians of three runs** per variant. Say when a difference is within run-to-run variation; a
  104 vs 93 ms "regression" once turned out to be drag-to-drag noise.
- **Build the instrument first.** If the page can't show the number the change is about, add the
  log field or the scripted step before changing the code.

## Setup

- **Production builds**, not the dev server. The dev server's HMR, unminified code and Svelte's
  dev-mode checks change timings.
- **Chrome 157 or later**, which every page needs since 0.3.0 (all chart text is drawn through
  HTML-in-Canvas). Note the machine and the display's refresh rate with the results: frame
  budgets depend on it (8.33 ms at 120 Hz).
- **One run per page load.** Reload between runs; the pages with **Run session** allow one run
  per load.
- **Hands off the mouse while a session runs.** Scripted pointer events go through the charts'
  own handlers, and so would the real mouse.
- **Same window between runs you compare:** size, display (the frame cadence is the display's)
  and zoom level.
- **DevTools closed** for timing runs, except when recording a trace (below): an open DevTools
  costs main-thread time of its own.

### A/B: two builds side by side

Compare a branch against `main` with two production previews on different ports, one served from
a scratch worktree:

```bash
# main, in a worktree outside the repo
git worktree add ../fjader-main main
cd ../fjader-main && ln -s ../fjader/node_modules node_modules
# the data is gitignored, so a worktree has none: link it in before building (the build copies
# static/ into its output; linked later, rebuild and restart the preview)
for f in ../fjader/static/data/*; do [ -e "static/data/$(basename "$f")" ] || ln -s "../../$f" static/data/; done
npm run build && npx vite preview --port 4180 --strictPort

# the branch, in the repo
npm run build && npx vite preview --port 4173 --strictPort
```

Before handing the pages over, check that both previews serve the data
(`curl -s -o /dev/null -w '%{http_code}' http://localhost:4180/data/flights-200k.parquet` gives
200): a missing file fails the page with "No files found that match the pattern".

Run the same page and session on each, alternating (A, B, A, B, A, B) rather than all of one
first, so drift (thermal, background work) spreads over both. Remove the worktree afterwards
(`git worktree remove ../fjader-main`).

**A port is a site, and a site has a cost of its own.** The browser keeps state per origin
(storage, caches, what a page left behind), and `localhost:4173` and `localhost:4180` are two
origins. One build served on each port, six and six, measured 0.1 to 0.15 ms more main-thread
work per frame on 4173, in every phase, in frames that drew nothing too; with the builds swapped
between the ports the difference went with the port, not the build. So for a difference of a few
tenths of a millisecond:

- **swap the ports half way** (A on 4180 and B on 4173, then A on 4173 and B on 4180), and compare
  by build over both halves; or serve both from ports nothing has used;
- **suspect the origin first when frames that do no work of yours differ** between the builds.
  `m4-session.json` and `dash30-*.json` carry each submit's time, so a frame can be split into the
  part before its submit, the part after, and frames with no submit at all.

A count (statements, objects made, passes) does not have this problem: one run per build is enough.

## Instruments

| Page                   | What it measures                                                                                                                                          | Options                                                                                                                                                                                                         | Scripted                                                                        | Log file                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------- |
| `/test/dashboard-30`   | 30 charts on one selection: per-frame main-thread and GPU time, dropped frames, text atlas uploads, WebGPU objects made, Long Animation Frames, per phase | `?labels=attached\|text\|0`, `?axes=0`, `?charts=N`, `?scale=N`, `?dots=0`, `?mutations=1` (costs time; off for timing runs), `?gputime=0` (no GPU timing: for GC runs), `?stack=js` (counts JS transform runs) | **Run session**: idle, toggle, clear, brush, unbrush, sort, pan, zoom, idle-end | `dash30-<variant>.json`     |
| `/test/m4-decimation`  | Decimated lines (100K points, three series): per-frame main-thread and GPU time and WebGPU objects made, per phase                                        |                                                                                                                                                                                                                 | **Run session**: idle, hover, pan, zoom, pan-y, idle-end                        | `m4-session.json`           |
| `/test/query-load`     | Every statement sent to DuckDB at load and during a brush: queue wait, work, connection                                                                   | `?mount=all\|visible\|top`, `?scale=10`, `?dots=0`, `?slow=1`, `?cat=1`, `?share=N`, `?tooltipSort=on\|off`                                                                                                     | **Scripted drag**: one brush sweep                                              | `qlog-<options>.json`       |
| `/test/entrance`       | When each chart enters, and what held it                                                                                                                  | `?slow=1`                                                                                                                                                                                                       | **Replay**                                                                      | `qlog-entrance[-slow].json` |
| `/test/click-session`  | Selection clicks: which reach the base table, and their cost                                                                                              | `?rows=N`, `?variant=eager\|patient`                                                                                                                                                                            | **Run session**: hovers, clicks, brush moves                                    | `clog-<tag>-<variant>.json` |
| `/test/time-stack-fit` | A binned time histogram through zoom-driven rebins: y axis fits, label lag                                                                                | `?fit=0`, `?overlay=1\|line\|labels`, `?sparse=1`                                                                                                                                                               | **Run session**: zooms, pans, shift+scroll, zoom-outs                           | `rebin-<variant>.json`      |
| `/test/query-slicing`  | DuckDB-WASM facts (sections 9–14): lanes, types, DDL overlap, cancelled CREATE, statistics                                                                |                                                                                                                                                                                                                 | per section                                                                     | console                     |

Each page's header comment lists its options and session in full.

### Pixels: did a change alter what is drawn?

`/test/path-grid?capture=1` adds **Save captures**: a scripted sequence of states (load, a low and
a high brush, cleared, a toggle, cleared, fine bins, zoomed in) and, in each, a readback of every
case's canvases once they are at rest, saved as `captures-pathgrid.json`. There is no GPU or
browser test in CI; this is the net under a change that should not alter what any case draws.

```bash
uv run scripts/measure/captures.py main=captures-a.json branch=captures-b.json --out /tmp/diffs
```

- **Two runs of one build first.** A capture that differs between them is not stable and says
  nothing about a change; `captures.py` lists captures that never came to rest.
- **Same window size and display** for runs you compare: a different width is a different chart.
- **At rest only.** A frame in the middle of a transition is not captured: the animation clock
  follows real time, so two runs would not land on the same frame.
- Readback is opt-in because a canvas that can be read back is configured with another usage.

`?dots=0` leaves out the raw-row scatters. They read every row on every update, so at
`?scale=N` they swamp what the aggregated marks' queries cost: use it when the change under test
is in aggregated queries, and say so with the numbers (the log's name carries `-nodots`).

### The building blocks

- **Statement log** (`src/lib/query-engine/debug/query-log.ts`): `attachQueryLog(queryEngine)`
  records every statement the engine sends, with its class, connection, source, caller, and the
  main-thread times it was requested, sent and settled. `download(name, extra)` saves it.
- **Frame probe** (`src/routes/test/dashboard-30/frame-probe.ts`): per rendered frame, the
  interval (`dt`), the main-thread time to the end of rendering (`work`), text atlas uploads, the
  phase; per `queue.submit`, the time until the GPU reports it done; Long Animation Frame entries.
  `summarize()` gives the per-phase table the page shows.
  - **`created`**: per frame, the WebGPU objects the page made, by kind (command encoders, compute
    and render passes, canvas textures, texture views, bind groups, buffers, textures,
    `onSubmittedWorkDone` promises) and its `writeBuffer` uploads. Counted on the interfaces'
    prototypes, so whoever made them; counting allocates nothing. `dash30.py --created` tabulates
    them.
  - **Timing the GPU allocates per submit** (a promise; with pass timestamps, closures and a
    readback). For a run that measures garbage collection, `?gputime=0` leaves it out; the counts
    stay.
  - **`?churn=N`** is an experiment, not a setting for timing runs: N texture views of one small
    unused texture, made and dropped on every frame of the session (they show in `created` as
    `textureViews`). Wrapper garbage and nothing else, so a trace with and without it is a dose
    test of whether that garbage is what the collector's sweeps cost.
- **Entrance observer**: `gpuCoordinator.observeEntrances` for when charts enter.

## Scripted interactions

A session is an async script on the page that dispatches real DOM events on the chart's own
elements, so they go through the same handlers as a user's:

- **Pointer events** are `PointerEvent`s with `pointerId: 1`, `pointerType: 'mouse'`,
  dispatched on the chart's `svg.svg-foreground`. Moves are sent as `pointerrawupdate` where
  `ChartCell` listens for it (Chrome, top-level window), else `pointermove`.
- **Pointer capture** throws for a synthetic pointer id, so sessions stub
  `Element.prototype.setPointerCapture` / `releasePointerCapture` while they run and restore them
  after.
- **Hover is scripted too:** `pointerenter` before acting on a chart and `pointerleave` after,
  or the chart left behind still counts as hovered.
- **Positions come from layout, not from DOM text:** a click on an axis label is placed by the
  band slot's position in the plot rectangle, so scripts keep working when labels draw on the
  GPU.
- **Where an event lands matters:** a wheel or drag in the x axis margin moves x only, as a user
  zooming the time axis; inside the plot it moves both axes.
- **Pacing by frames:** moves are sent once per `requestAnimationFrame`, sweeps by elapsed time,
  so a slower frame doesn't change the path.
- **Waits are explicit:** a phase that needs a steady state (preagg builds after a hover) waits
  for it, capped, and the log says how long it waited.

Every step is recorded with its time (`events` in the log), and since 2026-11 also as a User
Timing mark named `fjader:<kind>:<label>` (`fjader:phase:brush`, `fjader:drag:start`), so a
performance trace shows the session's phases.

A scripted brush measured the wrong thing before #159 (2026-11-25): on a 2x display Chrome
reports a synthetic event's `offsetX` wrong, the brush selected a range outside the plot, and
the queries fell back to the base table. On `/test/dashboard-30` no brush-phase statement read
a preagg table. Brush numbers from a scripted session before that change are not comparable
with later ones. When a brush phase looks cheap or odd, check the selected range and the tables
read in the log's `statements` first.

To add a session to a page: copy the pointer helpers from `/test/dashboard-30` (`pointer`,
`frame`, `sleep`, `mark`, `phase`), keep one run per page load, and save the events with the
log.

## Getting the data out

Measurements leave the browser as files, not console output: console tables don't copy as text,
and pasting through the clipboard into a terminal is fragile.

- **Save log** downloads JSON to `~/Downloads`. Repeated downloads of the same name get ` (1)`,
  ` (2)` suffixes; `ls -lt ~/Downloads/qlog-* ~/Downloads/dash30-*` shows the newest.
- **What's in a log:**
  - Statement logs: `statements` (SQL, kind, class, connection, source, caller, `requested`,
    `start`, `end`), `identityRequests`, preagg `builds`, plus the page's extras (mount time,
    entrances, `drag`, `events`).
  - `dash30-*`: `variant`, `params`, `viewport` (size, DPR), `userAgent`, `events`, the per-phase
    `summary`, and `probe` (per-frame arrays: `ts`, `work`, `elementDraws`, `created`, `phase`; per-submit
    GPU times; Long Animation Frames with their scripts).
- Give the file names to whoever analyses them; an agent reads them from `~/Downloads`.

### Chrome performance traces

A trace shows what the counters can't: which functions, style and layout work, garbage
collection and GPU process work fill a frame. Use it to explain a number the logs found, not
instead of them (recording costs time, so traces are not for comparing totals).

To record one:

1. Open DevTools → **Performance**. In its settings, turn screenshots off unless you need them
   (they make the file much larger).
2. Load the page, press **Record**, start the session, and stop when the session's summary
   appears.
3. **Save trace** (the download icon). It lands in `~/Downloads` as `Trace-<timestamp>.json` or
   `.json.gz`. Record one per variant, under the same conditions, and say which is which.

`scripts/measure/trace.py` reads it (below). It splits the trace into the session's phases by
the `fjader:*` User Timing marks (a trace without them is one window), and reports per phase the
page's main-thread busy time (`CrRendererMain`, top-level tasks), the garbage collection within
it, and the GPU process's main-thread busy time (`CrGpuMain`); then the events with the most self
time in one phase, so nested events (`RunTask` > `FunctionCall` > `MinorGC`) aren't counted
twice. Event names vary across Chrome versions; check what a trace contains before relying on
one.

## Analysis

The scripts in `scripts/measure/` read the saved files (standard library only; run them with
`uv run`). Each takes files or `label=file` arguments: runs with the same label are one variant,
and every number is the median over its runs, with the range where it helps.

```bash
# dashboard-30: per phase, total and per-frame main-thread work, dropped frames, GPU time
uv run scripts/measure/dash30.py main=a.json main=b.json main=c.json branch=d.json branch=e.json branch=f.json

# any log with statements: count, span, work and queue wait, by group
uv run scripts/measure/qlog.py ~/Downloads/qlog-all*.json --window drag

# Chrome traces: per phase, main-thread busy, GC, GPU process; top self-time events
uv run scripts/measure/trace.py main=Trace-a.json.gz branch=Trace-b.json.gz --window brush

# and the JavaScript functions carrying the time in that phase, by self and by total time
uv run scripts/measure/trace.py main=Trace-a.json.gz branch=Trace-b.json.gz --window pan --match 'lod/|lifecycle'
```

`--functions` (or `--match PATTERN`, which implies it) reads the trace's CPU profile and prints
each function's milliseconds and its share of the window's sampled time that was not idle. A
production build's function names are minified, so to find WHICH function costs, record both
traces on the dev server, where names and files survive, and compare shares, not milliseconds.
The production A/B says how much; the dev trace says where.

`--gc` prints garbage collection as interruptions: per phase, GC time split into Blink's C++ heap
(`CppGC.*`: DOM nodes and WebGPU wrapper objects) and V8's, the tasks with GC in them, how many of
those ran longer than a frame (`--frame`, default 8.33 ms), and the most GC in one task. Report
the largest slice, not only the total: one 30 ms sweep is four dropped frames at 120 Hz. Set it
beside `dash30.py --created` from a run of the same build, which says what each phase made per
frame for a sweep to find.

`dash30.py` warns when runs differ in viewport or frame cadence: such runs don't compare. Each
script's `--help` lists its options. Write ad hoc Python only for what they don't answer, and
consider adding it to them.

What the numbers mean:

- **Queue wait** (statement logs): each connection serves its statements first in, first out, so
  a statement starts at the later of its send time and the end of the previous statement on its
  connection. A statement on a sliced lane interleaves with the main connection's in the worker,
  so its "work" includes slices spent serving the other. `qlog.py` folds per-run parts of table
  names (preagg hashes, view ids) into `*` so groups match across runs; `--raw` keeps them.
- **Main-thread times read high while the thread is busy:** a statement's settle time includes
  waiting for the main thread to get back to it (decoding, GPU uploads).
- **Frames:** p50 / p95 of `work` and GPU time per phase, and dropped frames against the idle
  phase's cadence, as the page's summary computes them.
- **Report** a table per phase or per step, with the build (`main` vs branch), the machine, the
  display rate, the window size and the number of runs, as in the measurements of #96. Say when
  a difference is within the runs' spread.

## Agent skill

A coding agent can follow this procedure as a skill: decide the metric, set up the A/B previews,
hand over the routes and run order, find the downloads, run the scripts, report, clean up. The
maintainer keeps one locally (`.agents/skills/measure/`, gitignored while it is evaluated); this
document and the scripts are what it builds on.
