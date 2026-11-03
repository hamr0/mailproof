# archive/v1

mailproof 1.x code, tests and docs, frozen at tag `v1.4.0`. Kept for borrowing, not run, not type-checked, not shipped (not in `files`, not matched by the `npm test` globs, excluded from `tsconfig.json`).

Layout: `src/` (v1 modules), `tests/` (their tests and helpers), `poc/` (v1 P0 pipeline), `docs/` (v1 PRD, DESIGN, P2 audit, OPS, `config.example.env`).

The files here still import each other and the live `src/proof/` by their old relative paths, so they are not expected to run from here.

To reuse a part in v2: `git mv` it and its tests back into `src/` and `tests/` (fix the imports) and make them pass. Reuse map: `docs/product/PRD.md` section 9.
