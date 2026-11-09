# Prune-before-date POC (M3 build step 3; throwaway, never shipped)

Question: which mechanism rewrites a trail to drop everything captured before a cutoff, keeping every kept commit's message,
author, dates and every kept file byte-identical, fast and memory-bounded at 20k and 80k commits, with no new runtime
dependency (the `git` binary plus Node stdlib only)? Spec under test: PRD §7 M3 "Prune before date" (6 steps), decisions-log
"M3 scope" item 8, SPEC B3/B5/B6/B7.

> **Update 2026-11-09:** the trail layout this POC was run against (flat `records/<id>.json`, `replies/<id>.<slug>.json`) is gone. The owner decided to shard it (`records/<id[0:2]>/<id>.json`, `replies/<id[0:2]>/...`) because of the O(N)-per-commit tree cost measured below; see SPEC B3 and findings F24. The scripts and results here are unchanged and describe the flat layout; a prune built for the product walks the sharded paths.

## Options

| | mechanism | file |
|---|---|---|
| **A** plumbing replay | one pass of `git log --raw`; per kept commit `update-index --index-info` on a temp index, `write-tree`, `commit-tree -p prev` with the original GIT_AUTHOR_*/GIT_COMMITTER_*; message on stdin. 3 `git` processes per commit | `a.js` |
| **B** fast-export / fast-import | `git fast-export --no-data` of the whole history -> Node stdlib stream transform -> `git fast-import` into a fresh bare repo; blobs are not copied (alternates to the old object store), a final `repack -a -d` makes the new repo self-contained and drops the alternates. `--data` variant streams the blob bytes instead | `b.js` |
| **C** B on the kept range only | same transform, but only the kept range is exported (chunks of K commits with `--reference-excluded-parents`), and the root tree is read from the last pruned commit's tree | `c.js` |

Raw results: `results/` (bench.jsonl: failed runs removed, check.log, swap-result.json, negative-control.txt). Common: `lib.js` (plan, path filter, log-with-ops stream, fast-export parser), `check.js` (correctness), `bench.js` (time + RSS
tree sampling), `gen.js` (synthetic trails), `swap.js` (swap + crash recovery), `verify-cost.js` (step 4),
`negative-control.js` (can the checker fail), `materialise-cost.js`.

What a run does, in all options:

1. **Plan** (`lib.js#plan`). Walk commits oldest first. The pruned prefix ends at the first commit that adds a record whose `captured` is at or
   after the cutoff. Pruned record ids = records added in the prefix. Then read every kept record at HEAD: collect its
   `signatures[].key_file` (the archived keys it needs) and count stragglers (below).
2. **Root = the prune notice**: no parent, message with `cutoff`, `previous-head`, `removed`, `kept` (and `earlier-prune-*` lines when the root it replaces was itself a
   notice). Its tree is the filtered tree of the prefix: `trail.json` plus the keys kept records need (plus anything else not a pruned class).
3. **Replay** each kept commit with its original message/author/committer/dates and its tree ops minus pruned paths. Pruned paths: `records/<id>.json[.ots]`, `replies/<id>.*` for a pruned id, and any `keys/**` file that
   was first committed in the prefix and no kept record references. A kept commit left with no ops (a reply-text commit for a pruned record) is **dropped**.
4. Repack, remove alternates, `fsck`.

Date choice: author date and committer date are both preserved exactly (the library sets them equal; the checker compares both).
Only the notice commit has a new date (now).

## Method and data

`gen.js` builds a synthetic trail with `git fast-import` (a plain `git commit` loop is too slow to build 80k): `trail.json`, one
commit per record (`records/<32hex>.json` about 4 KB of pseudo-random JSON in the real field layout, a `.ots` of 1.2 KB on 5% of them, new key files on the commit
that first uses them), 399 key files out of a sliding window so early keys retire, and about 4% extra reply-text commits made
later for a random earlier record (`replies/<id>.mailproof-quote-1.json`). 2% of records are captured up to 3 days before their commit position (clock skew), to test the prefix
assumption. Commits are linear, author = committer date, subject as the library writes it. The cutoff is the `captured` of the record at the 50% position.

Each run is `bench.js`: `/usr/bin/time` for wall/user/sys of the whole process tree and a 200 ms `/proc` sampler for the **summed RSS** and **summed anonymous
memory** of the tree (RSS also counts the memory-mapped pack pages, which the kernel can drop; anon is the real heap). The box is shared and was loaded
(load 4 to 14 from other sessions), so wall is noisy and even CPU time swings by a third between identical runs (B-20k: 213, 161, 115 s of CPU in three runs); read the
CPU column as +-30%.

## Results

20,000 records (+755 reply commits, +1 init = 20,756 commits; 22,131 paths at HEAD). Cutoff at 50%: 9,999 records removed, 10,001 kept, 10,357 prefix commits, 10,134 kept commits
replayed, 265 dropped as empty (reply-text for a pruned record), 1 straggler kept (below), 141 key files dropped, 258 carried into the root.

| option | wall | CPU (user+sys) | peak anon memory (tree) | peak RSS (tree) | correct (check.js) |
|---|---|---|---|---|---|
| A plumbing, full run | 551 s | 615 s (sys 300) | 410 MB | 506 MB | yes |
| B fast-export/import, no-data + alternates | 91 s (to 111 s) | 115 s (to 213 s under load) | 430 MB | 606 to 876 MB | yes |
| B `--data` (blobs streamed) | 141 s | 198 s | 382 MB | 905 MB | yes at 2k; not re-run at 20k |
| C kept range only, chunked | 90 s (to 100 s) | 118 s (to 126 s) | 420 MB | 532 MB | yes |

Phase split of B at 20k: plan 8 s, export+import 70 to 87 s (fast-export alone about 29 s CPU, so fast-import is the rest), repack 14 to 21 s.
Normal working-tree materialisation of the result (`reset --hard`, 10.5k files): 0.4 s. The two renames of the swap: 0.04 ms.

A per-commit cost, sampled where a full run is not practical (`a.js --sample=<kept index>,150`, wall ms per replayed commit, loaded box): 51 ms at a 0.6k-entry tree (2k trail, full run 55 s), 60 ms
at 5.3k entries, 83 ms at 10.4k entries. It is flat-ish because three process spawns dominate; the temp index is rewritten whole each time.

### 40k and 80k

Same generator and 50% cutoff. 40,000 records = 41,587 commits (43,930 paths): 19,999 removed, 20,001 kept, 20,755 prefix commits, 20,270 kept commits replayed, 562 dropped, 1 straggler.
80,000 records = 83,190 commits (the trail pack is 4.6 GB): 39,995 removed, 40,005 kept, 41,582 prefix commits, 40,514 replayed, 1,094 dropped, 5 stragglers.

| size | option | wall | CPU | peak anon (tree) | peak RSS (tree / largest process) | phases (plan / export+import / repack) | correct |
|---|---|---|---|---|---|---|---|
| 20k | B | 91 s | 115 s | 430 MB | 606 / 424 MB | 8 / 70 / 14 s | yes |
| 40k | B | 443 s | 522 s (box at load 10+) | 445 MB | 1,516 / 1,272 MB | 27 / 313 / 103 s | yes |
| 40k | C | 576 s | 673 s (load 12) | 348 MB | 714 / 595 MB | 63 / 472 / 41 s | yes |
| 80k | B | **2,578 s (43 min)** | **2,794 s** | **442 MB** | 5,446 / 5,082 MB | 118 / 2,272 / 188 s | yes (check.js 17 min: 40,514 commits compared, 164,977 objects all reachable, fsck ok) |
| 80k | A | not run in full: about 2.4 h wall extrapolated from samples (below) | | | | | |

Growth is quadratic: CPU x4.5 from 20k to 40k and x5.3 from 40k to 80k (the loads differ, so the factor is 4 to 5), while the anonymous memory stays at 350 to 445 MB at every size. The large RSS at 80k is the memory-mapped 4.6 GB source pack (page
cache the kernel can drop), not heap. A per-commit samples at 80k (`a.js --sample`, wall ms per replayed commit, B running alongside): 24.5 ms at a 0.1k-entry tree, 162 ms at 20.5k, 507 ms at 41k; integrated over the 40k kept commits that is about 8,500 s,
and 40k loose tree objects of 0.1 to 2.7 MB each would be tens of GB on disk if not repacked on the way (`a.js` repacks every 2,000 commits).

### The quadratic is git's, not the mechanism's

`records/` is one flat directory, so every commit's tree has N entries and every tree object is O(N) bytes (about 67 B per entry). Replaying K commits writes O(K*N) tree bytes. This is what makes
a one-commit-per-record trail quadratic in git itself (already seen in the trail-index POC, F19): building the synthetic trails with fast-import took about 7 minutes at 20k and about 1 h 45 min at 80k. Prune cannot avoid it (every kept commit needs a new tree because the pruned entries disappear from all of them), only halve it (the kept trees are about half as large): the floor is hashing and writing the new trees. I did not profile fast-import further (it is about 75% of B's CPU; fast-export 25 s of 115 s at 20k), so how close it is to that floor is unmeasured. A sharded layout (`records/ab/<id>.json`) would fix it for the trail itself, for index catch-up and for prune; it is a layout change and out of scope here, but it is the real fix if trails of 80k+ matter.

### Memory

Bounded by git's own caches, not by the trail: each long-lived `git` child holds about 200 MB of anonymous memory (delta base cache, object cache) at 2k commits and at 20k commits alike, and the Node transform holds the
pruned-id set, the carried paths and one commit (75 to 80 MB). Total tree anon peak 410 to 430 MB at 20k for A, B and C, and 442 MB for B at 80k (a flat line over 4x the trail). C's chunking gave 420 MB vs 430 MB at 20k and 348 MB vs 445 MB at 40k (each `git log`/`git fast-export` still reaches ~205 MB), and B stays flat at 442 MB at 80k, so it is not needed for memory. RSS (incl. mapped packs) is higher and reclaimable.

## Correctness (check.js; all of it, A, B and C at 20k; B and C at 2k, `--data` at 2k)

`check.js <old> <cutoff> <new>` recomputes the plan from the old repo and then:

- **Linear**, every new commit has exactly one parent, the root has none; the root is the notice, with `cutoff`, `previous-head` (= old HEAD), `removed`, `kept` equal to the plan.
- For every kept commit: **message, author name/email/date, committer name/email/date identical**, in the same order; the commits dropped are exactly those whose every op touches a pruned path.
- **Tree ops equal** (path, deleted or blob sha) to the old ops minus pruned paths, commit by commit, starting from a root tree equal to the filtered prefix tree; by induction every kept tree equals the old tree minus pruned paths.
  Blob sha equality is byte identity of every kept file. The final HEAD trees are also compared as full path -> sha maps, from `git ls-tree`.
- **No pruned path in any tree op or in the final tree**; no record id of a pruned record left anywhere; every key a kept record references is in the root tree and in the final tree; keys used only by pruned
  records are gone (141 of 399 at 20k).
- Object store: no alternates file, `git fsck --strict` passes, **object count == reachable object count** (no pruned blob left unreachable in a pack), and a sample of 200 pruned record blobs is absent.

20k result for A, B, C: `ok: true`, 10,134 kept commits compared, 265 empty ones dropped, 41,955 objects all reachable, fsck ok.

**Negative control** (`negative-control.js`): the checker exits 0 on the undamaged result and non-zero on each of: a changed commit message, a changed author date, a pruned-looking record file added to the final tree, one changed byte in a
kept record blob, and a wrong cutoff (notice mismatch). All five are caught, each by the intended check.

## Step 4, re-verify (verify-cost.js)

`verifyRecord` (offline DKIM, RSA-2048, from the record alone) over 300 real records recorded through `Mailproof#record()` with signed test mail: **0.41 ms per record** (all 300 pass). Extrapolated:
10k kept records 4 s, 40k kept records 17 s. Small next to the replay. It cannot fail because of the replay, though: the kept record blobs are byte-identical (sha equality, checked above), so a re-verify
can only report what was already true of the old trail. Not measured: the OTS part of step 4 (`ots info` per stamp needs the `ots` binary; a process per stamp, so about 5% of records at one process each would
dominate step 4 if stamps are on; the stamp file is byte-identical too).

## Swap and crash analysis (swap.js; run by `node swap.js <scratch>`; output kept in the scratchpad as swap-result.json)

Journal `<trailDir>/.<trail>.prune.json` beside the lock file, written with write-temp + fsync + rename. Steps, all under the trail lock:

| step | action | a crash after it leaves | recovery (at the next lock acquisition, before `ensureTrail`) |
|---|---|---|---|
| 0 | journal `building` | original untouched | discard `.prune-tmp`/partial build, drop journal. Live = old |
| 1 | build bare result | original + partial/complete build dir | same |
| 2 | materialise `<trail>.prune-tmp`, fsck, clean status | original + a complete tmp, journal still `building` | same (a verified build is discarded; the work is lost, nothing else) |
| 3 | journal `swapping` (+ new head) | original + complete tmp | roll forward: do steps 4, 5 |
| 4 | rename `<trail>` -> `<trail>.pre-prune-<date>` | **no `<trail>` at all**; backup + tmp | roll forward: rename tmp -> `<trail>` |
| 5 | rename tmp -> `<trail>` | new live + backup, journal `swapping` | detect the finished swap, run the post steps |
| 6 | journal `swapped`, post steps | new live + backup | re-run the idempotent post steps |
| 7 | drop journal | done | nothing |

Asserted for a crash injected at each point: after recovery `<trail>` is a clean, fsck-ok repo that is either exactly the old trail (crash before step 3) or the pruned one with the backup present (step 3 onwards);
no tmp, bare or journal left over; the sync cursor follows the HEAD it should.

Findings from this:

- **The gap between the two renames is real.** Two directory renames are not atomic together (`renameat2(RENAME_EXCHANGE)` is not in Node stdlib). A crash between steps 4 and 5 leaves no `<trail>`.
  If the next writer ran `ensureTrail` first, it would `git init` a fresh empty trail at the live path (reproduced: a plain open of the gap state creates a 1-commit empty trail) and recovery could no longer rename the pruned trail into place.
  So **recovery must run first, inside the lock, before `ensureTrail`**, and any lock-free reader (`list`, `get`, ...) in the gap sees ENOENT for the length of one rename (microseconds in practice).
- The lock file `.<trail>.lock` and the sync cursor `.<trail>.sync.json` sit beside the repo, so they survive the swap; so would the journal. Locks held across the swap are fine because only the lock holder renames.
- The new repo must keep the old repo's `.git/config` (`user.name`/`user.email` are set by `ensureTrail` locally); `materialise()` copies them. The bare result needs `core.bare=false` and a `reset --hard` to populate the working tree.
- `<trail>.pre-prune-<date>` holds the pruned proofs and the history intact; `--delete-backup` is a plain recursive delete after step 7.

### Interplay with the rest of mailproof

- **Sync cursor: the PRD's step 6 is wrong as written, and this one is serious.** `sync` stores the trail HEAD in `.<trail>.sync.json` and, if that HEAD "is not the trail's current HEAD or an ancestor of it", discards every cursor and rescans every
  folder from UID 1 (`reset: 'trail'`, B4.2, `sync.js` lines 199 to 201, 435). After a prune the old HEAD is not an ancestor of the new one (shown in `swap-result.json`: `oldHeadIsAncestorOfNewHead: false` after every swapped case). The rescan
  re-downloads the whole mailbox, and the id dedup (`records/<id>.json` must be in HEAD) does not recognise the pruned records any more, so **sync re-records every pruned mail with a new `captured`, undoing the prune.**
  The prune must itself rewrite the cursor's `head` to the new HEAD (cursors stay; it is a post step of the swap, idempotent, done by `swap.js#postSteps`).
- **Trail index (B5):** `meta.head` is not an ancestor of the new HEAD, so the next `list`/`copies` rebuilds from scratch under the lock. That already works; budget a full rebuild (F19 measured it) after every prune.
- **Content expiry (B7.5):** the scan sees HEAD change to a non-descendant and aborts that round ("rewritten under the scan"), as specified; the next round is correct. Content of pruned records is deleted after the swap; do
  it as "delete `raw/<id>.eml` for every id with no `records/<id>.json` in the new HEAD" (idempotent, needs no stored id list; the journal holds only counts), then the attachment sweep expiry already has.
  Do it after step 5, not before: until the swap commits the old trail still references the content.
- **Open `Mailproof` instances / the worker pool** hold no git state; but an index database connection (`better-sqlite3`) open on the old HEAD is stale after the swap, which the HEAD check handles.
- **The backup still contains everything pruned** (proof headers; the content store is not in git and is deleted). "Delete the pruned records" is only true after the backup is deleted.

## Assumptions in the PRD's six steps that turned out wrong or incomplete

1. **"The cutoff is a prefix of history (commits are made at capture time)."** Mostly, not exactly. `captured` is the clock at capture and the commit order is the capture order, but a clock step backwards or a
   skewed host makes a later commit carry an earlier `captured`. With 2% jitter, 1 record in the kept range at 20k was captured before the cutoff. Rule used: prune the longest commit prefix in which every record is before the cutoff; a straggler after it is **kept** and reported
   (`stragglers`). Pruning it too would be a range deletion in the middle (tampering, PRD). The command must show "N records captured before the cutoff were kept because they sit after a later one".
2. **"Replay each kept commit."** Not every kept commit survives: a reply-text commit (B6) for a pruned record is made later, so it sits in the kept range but touches only pruned paths. It is **dropped** (otherwise it would be an empty commit whose message names the pruned
   record, `reply-text <id12> ...`). 265 of 10,399 at 20k. So "kept commits" is not "all commits after the cutoff", and the checker has to expect it.
3. **"Archived keys used only by pruned records."** A record references its key by `signatures[].key_file`, but the key of an attached original (a forward's inner signature) is committed and **not referenced** by the record
   (`AttachedOriginal` carries only `d`). Rule used: a key first committed in the prefix stays iff a kept record's `key_file` names it; a key first committed in the kept range always stays. This never drops a key any kept `verifyRecord` needs
   (the inner message is not stored, nothing re-verifies against that key). A key introduced with a pruned record but used by a kept one must be in the **root** tree (it exists before the first kept commit): 258 such at 20k; the root is not empty of keys.
4. **Step 2, "write a new first commit".** The tree of that commit cannot be empty: it must hold `trail.json` and the carried keys, otherwise the first kept commit's tree would not equal the old one. A second prune replaces the first notice (a pruned commit); the new notice carries `earlier-prune-*` lines so the chain is not lost
   (tested: second prune on a pruned trail passes the checker).
5. **Step 4, re-verify.** Cheap (0.4 ms a record) but vacuous as a safety gate: blob equality already proves the records unchanged. Keep it as a report ("N kept records verify; M do not, same as before"), do not make a failing record abort the prune
   (accept-with-flag: a record that fails DKIM is a legitimate record).
6. **Step 5, "a failure leaves the original untouched".** True up to the rename, but the swap is two renames with a no-trail gap, so it needs a journal and recovery-before-`ensureTrail` (above).
7. **Step 6, "the index fully rebuilds ... (it already detects rewritten history)".** True for the index and for content expiry, **false for the sync cursor**, which re-records the pruned mail (above).
8. **Cost.** The PRD implies replay is linear. It is O(commits x tree size) because `records/` is flat. Fine at 20k (about 2 minutes, one-off), 43 minutes at 80k.

## Recommendation

**Use option B (fast-export, Node transform, fast-import), with `--no-data` and alternates + a final repack.** Reasons: it is the only one that keeps the O(commits x tree) work inside one `git fast-import` process (A pays three process spawns, an index
write and loose tree objects per commit: 5 times the CPU and half of it system time at 20k, and tens of GB of loose objects at 80k unless repacked on the way); it is a ~150-line stdlib transform with no new dependency; and the correctness checker passes bit-for-bit.
C (kept range only, chunked) is the same speed at 20k and no lower memory, so its extra moving parts are not worth it; keep it in mind only if the plan phase is split off. `--data` costs 70% more CPU and gains nothing.

Build around it: the plan + check code (`lib.js`, `check.js` logic) as the shipped verifier ("a prune is accepted only if `check` passes against the old trail", run before the swap), the journal + recover-first swap, and the cursor rewrite as part of step 6.
Report the stragglers and the dropped reply-text commits to the user. Expect time proportional to N^2: say so in the command's output (about 1.5 to 2 minutes at 20k, 7 minutes at 40k, 45 minutes at 80k).

## Re-run

```bash
S=<scratch dir>                                  # never /tmp directly
node poc/m3-prune/gen.js $S 20000                # 20k trail (about 7 min; 80k about 1 h 45 min and 5 GB of tmpfs)
C=$(node -e "import('./poc/m3-prune/lib.js').then(l=>console.log(l.cutoffAtFraction('$S/trail-20000/t',0.5)))")
node poc/m3-prune/bench.js B $S/bench.jsonl -- node poc/m3-prune/b.js $S/trail-20000/t $C $S/out-b.git
node poc/m3-prune/check.js $S/trail-20000/t $C $S/out-b.git
node poc/m3-prune/swap.js $S && node poc/m3-prune/negative-control.js $S && node poc/m3-prune/verify-cost.js $S 300
```
