# Status-refresh POC (throwaway, never shipped), finding F39

Cost of a schema 6 index rebuild, a catch-up and `status({ refresh: true })` on synthetic trails.

```bash
S=$(mktemp -d)                              # or a scratch dir; delete it afterwards
node gen.mjs $S 20000                       # builds $S/trail-20000 (about 15 s); needs tests/helpers, not shipped
node run.mjs $S 20000 3 > res-20000.json    # 3 reps of every cell, one process per measurement (needs /usr/bin/time)
rm -rf $S
```
