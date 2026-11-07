# Trail index POC (throwaway, never shipped)

Question (finding [F19](../../docs/product/findings.md)): `list()` and `copies()` read and parse every record (F18, about
65 to 110 us per record, linear), and M3 needs "find my record by Message-ID". Is an index beside the trail worth a
dependency, and which engine? Candidates measured, all against the same answers:

- **C** the shipped code: `Mailproof#list` / `#copies` (full read), plus a naive full-read Message-ID scan.
- **A** `node:sqlite` (`DatabaseSync`), **B** `better-sqlite3`: one SQLite file beside the trail, outside git, a rebuildable
  cache keyed on the trail's git HEAD (rebuild when HEAD differs and the old HEAD is not an ancestor path we can diff,
  otherwise catch up from `git diff --name-only old new -- records`; a record commit inserts and moves the stored HEAD).
- **D** `list` via `git log -n limit --grep '^record <id12> <direction> '` (one commit per record), then read only those records.
- **E** (stdlib, no dependency) a JSON-lines sidecar loaded into Maps: only the per-process load was measured.

## Files

| file | what |
|---|---|
| `seed.mjs` | records the committed real fixture (`tests/integration/fixtures/signedreply-sample.eml`, production DKIM key) plus 3 signed helper mails through the real `Mailproof#record()`: the genuine records everything is cloned from |
| `gen.mjs` | clones them to N records (varied id, message_key groups, shared Message-ID per group, 2% null key, captured with 3% out-of-order jitter, direction, trust, body_status, copy kind, `attached_original` on forwards/digests), writes the trail layout the library uses and builds history with `git fast-import` |
| `index.mjs` | the candidate index, both engines behind one adapter; reuses the library's `listIds`/`readRecord`/`git` |
| `bench.mjs` | one measurement per process (so RSS is per measurement); every index answer is `assert.deepStrictEqual` to the full-read answer and the process exits 2 on any difference |
| `run.mjs` | driver: generate, measure everything, write `results-<size>.json`, delete the trail |
| `e-jsonl.mjs` | strategy E load cost (synthetic rows, same columns) |

## Re-run

```bash
cd poc/trail-index && npm install            # installs better-sqlite3 here only
mkdir -p .tmp && nice -n 19 node seed.mjs .tmp       # genuine seed records
nice -n 19 node run.mjs 1000j0,1000,10000,100000     # about 10 min on a loaded box; deletes each trail after its size
rm -rf .tmp                                          # synthetic trails live here
```

`node_modules/`, `package-lock.json` and `.tmp/` are git-ignored by this directory's own `.gitignore`; the root
`package.json` and lockfile are untouched. 100k uses ONE commit holding all records (one commit per record is quadratic in git
itself: every commit rewrites the N-entry `records/` tree), so D is measured at 1k and 10k only.

## Can the test fail? (checks run)

- Every index query answer is compared to the full-read answer (11 queries a size, including an unknown key, a record with
  `message_key: null`, a key with 5 copies, a key with `contained_in`, a Message-ID shared by 5 copies, and an unknown
  Message-ID). Negative control: deleting the `att` rows for one key from the index file made `queries` exit 2 with the diff.
- D has a positive and a negative control: on a trail with no capture-time jitter (`1000j0`) its answers equal the
  full read in 4/4 queries; with 3% jitter they differ (below).
- After 40 commits through the library's own `commitRecord()` plus index inserts, and 100 commits made without the
  index followed by a catch-up open, the index row count equals the number of record files and `list` / `copies` equal the
  full read of the mutated trail.
- Caveats on the data: clones share the seed records' signatures and keys (they are not `verifyRecord`-valid), record size
  is the real 3.3 to 3.5 KB; `attached_original` links are synthetic; the page cache is warm (cannot drop caches without
  root); the box is shared and loaded (another user process, load 2 to 8), so 100k full-read times swing between 10 and 30 s.
  `better-sqlite3` was 12.11.1 for the 10k and 100k rows and 13.0.3 for the 1k rows (re-run: same shape, see below).

## Results (medians; times in the unit shown)

Full read (C), ms per call, 3 to 5 runs, each query in its own process:

| N | list 10 | list 10 in | copies(key) | copies contained | by Message-ID | peak RSS |
|---|---|---|---|---|---|---|
| 1,000 | 118 | 117 | 85 | 94 | 82 | 132 MB |
| 10,000 | 1,232 | 1,253 | 992 | 928 | 1,451 | 467 MB |
| 100,000 | 10,627 to 11,290 | 11,290 | 28,272 (loaded) | 29,791 (loaded) | 26,205 (loaded) | 1,851 to 2,095 MB |

Indexed queries, microseconds per call (15 calls per process, 3 processes; A = node:sqlite, B = better-sqlite3):

| query | A 1k | B 1k | A 10k | B 10k | A 100k | B 100k |
|---|---|---|---|---|---|---|
| list 10 | 73 | 40 | 89 | 45 | 70 | 42 |
| list 10 in | 66 | 43 | 93 | 45 | 66 | 44 |
| list 1000 | 4,038 | 2,007 | 4,949 | 2,319 | 5,348 | 2,509 |
| copies(key, 5 copies) | 55 | 28 | 71 | 36 | 56 | 32 |
| copies(key, contained_in) | 36 | 23 | 47 | 26 | 54 | 33 |
| copies(id, null key) | 13 | 8 | 16 | 8 | 15 | 8 |
| copies(unknown key) | 12 | 11 | 13 | 12 | 12 | 12 |
| by Message-ID (5 copies) | 13 | 7 | 15 | 8 | 13 | 8 |
| by Message-ID (unknown) | 4 | 4 | 5 | 4 | 4 | 4 |

Index lifecycle:

| | A 1k | B 1k | A 10k | B 10k | A 100k | B 100k |
|---|---|---|---|---|---|---|
| cold rebuild from records | 146 ms | 145 ms | 1.53 s | 1.44 s | 40.7 s | 36.4 s |
| rebuild peak RSS | 97 MB | 96 MB | 146 MB | 147 MB | 211 MB | 233 MB |
| index file | 0.6 MB | 0.6 MB | 5.5 MB | 5.5 MB | 54.2 MB | 54.2 MB |
| open + HEAD check, up to date | 4.0 ms | 4.3 ms | 4.5 ms | 4.2 ms | 3.7 ms | 4.0 ms |
| of which `git rev-parse HEAD` | 2.9 | 2.9 | 3.3 | 3.2 | 2.6 | 2.8 |
| first open in a process (module load + open) | 16 ms | 20 ms | 20 ms | 21 ms | 16 ms | 18 ms |
| one record's index insert | 0.18 ms | 0.20 ms | 0.30 ms | 0.28 ms | 1.15 ms | 1.08 ms |
| the same record's git commit (`commitRecord`) | 40 ms | 44 ms | 129 ms | 117 ms | 853 ms | 846 ms |
| catch-up of 100 records after a stale HEAD | 36 ms | 31 ms | 43 ms | 43 ms | 171 ms | 160 ms |

100k rebuild: the first, loaded run measured 116.5 s (A) and 37.4 s (B); three quiet repeats gave A 40.7, 40.6, 40.9 s and
B 36.4, 36.2, 36.4 s. The 116 s was machine noise, not the engine. better-sqlite3 13.0.3 at 1k: rebuild 154 ms, list 10 59 us,
copies 34 us, Message-ID 9 us, answers equal.

D, `git log` for `list` (1k / 10k): 7.8 / 46.9 ms for `list({limit:10})`, 7.8 / 47.4 ms with direction `in`, 166 / 1,462 ms for
`limit: 1000`. Correct only if capture order equals commit order. No jitter: 4/4 equal to the full read. With 3% of records
captured earlier than their commit position: `list10` differs at 1k, matches at 10k; `list10out` and `list1000` differ at both.
Over the last 2,000 commit prefixes of the 10k trail the top 10 matched in 1,463 of 2,000 (73%); for direction `in` 1,158 of
1,607 (72%). In the library `captured` is the clock at record time, so out-of-order capture needs a clock step or an injected
`now`; the jitter here is an adversarial assumption, not a measured rate. D cannot answer `copies` or Message-ID.

E, JSON-lines sidecar loaded into Maps, per process (synthetic rows): 6 ms / 47 to 59 ms / 432 to 466 ms at 1k / 10k / 100k,
RSS 52 / 77 / 191 MB, file 0.3 / 2.8 / 28.5 MB. Queries after the load are Map lookups (not timed). Append, staleness and
equality with the full read were NOT built for E.

## `node:sqlite` ExperimentalWarning (Node 22.22.2, the only Node installed here)

Printed on import (`ExperimentalWarning: SQLite is an experimental feature and might change at any time`), in the main
thread and in a Worker. Not suppressible from library code: `process.noDeprecation` has no effect, `process.on('warning')`
only observes it. Suppressed by `node --disable-warning=ExperimentalWarning`, `NODE_OPTIONS=--disable-warning=ExperimentalWarning`,
`NODE_NO_WARNINGS=1`, or `new Worker(..., { execArgv: ['--disable-warning=ExperimentalWarning'] })` (control: the same worker
without it, or with `execArgv: []` as mailproof's pool passes, warns). Node 22.19 (the engines floor) is not installed: not
run. Also seen: this Fedora Node reports `process.versions.sqlite` 3.50.2 but `sqlite_version()` 3.51.2 at runtime, so the SQLite
inside `node:sqlite` depends on how the Node build was made; better-sqlite3 13.0.3 bundles 3.53.4.

## better-sqlite3 install facts

- 12.11.1 (`^12`): 38 packages in the tree (`npm ls --all`), 15 MB, 379 files, install 2.5 s with a warm npm cache; used a **prebuilt**
  binary (only `build/Release/better_sqlite3.node` present, no compile output) fetched by `prebuild-install` from GitHub at
  install time.
- 13.0.3 (latest, 2026-08-05): 2 packages (`node-addon-api` 8.9.2 is the only dependency), 27 MB unpacked, `gypfile: false`,
  **no install script**, 8 prebuilt binaries inside the npm tarball (darwin x64/arm64, linux x64/arm64 and musl x64/arm64,
  win32 x64/arm64), install 1.4 s warm, loads and runs on Node 22.22, `engines.node >=22`, SLSA provenance attestation, `npm audit` 0.
  Platforms outside those 8 were not tried.
