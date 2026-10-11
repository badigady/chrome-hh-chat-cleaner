# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Commands

- No package.json: there is nothing to install or build; the repo root **is** the extension. "Running" = chrome://extensions → "Load unpacked" (point at repo root) → open https://hh.ru/chat while logged in.
- Only test gate: `node test/verdicts.test.js` from the repo root. It is a self-contained custom harness (`test(name, fn)` inline, plain `assert`, `process.exit(1)` on failure) — **not** `node --test`/mocha/jest, and it has no single-test filter; it always runs all 19 tests in the one file. To check one behavior in isolation, `node -e "const V=require('./src/verdicts.js'); ..."` against `test/fixtures/live.json`.
- Only type/lint gate: `tsc -p jsconfig.json` (noEmit, `checkJs` on cleaner.js + verdicts.js only; `test/` and `icons/` are excluded in jsconfig.json). There is no ESLint or other linter.

## Style

- Browser code (`cleaner.js`, `verdicts.js`) is ES5-style: `var`, function declarations, no `import`/`export`. `verdicts.js` exposes the API through a UMD-style footer (`root.HhVerdicts` / `module.exports`) so node tests can `require` it. Test file may use CJS `require` and modern syntax.
- All comments, user-facing strings, log lines and git commit messages are Russian.
- Boundary that must not blur: `verdicts.js` is logic-only (no network, no DOM, no timers — that is why it is node-testable); all I/O lives in `cleaner.js`, which reaches it via `window.HhVerdicts` (9 exported fields: `buildChats`, `isNegotiation`, `canLeave`, `listReasons`, `newScan`, `accumulatePage`, `NO_CHATS_MESSAGE`, `plural`, `leftMessage`).

## Non-obvious

- The core rule of the whole codebase: **unsure → do not leave the chat**. Unknown `type`, unexpected response shape, or any read error leaves everything untouched; a failed list read aborts the whole pass.
- The "left" count comes from `applied` in the `POST /chatik/api/bulk/leave` answer — the extension **does not re-read the chat list** to verify. Re-posting an already-left chat returns the same 200 body (idempotent, verified 2026-10-09, `docs/bulk-leave.md`).
- `test/fixtures/live.json` is anonymized excerpts of **real** hh.ru responses (ids/names replaced, shapes verbatim). Keep it synthetic-safe: real ids/names must never be added to the repo.
- `docs/bulk-leave.md` is an endpoint spec graded with `VERIFIED` / `INFERRED` / `NOT VERIFIED` labels — treat `NOT VERIFIED` as hypothesis, not fact.
- `.cixignore` hides `.roo/`, `test/`, `README.md`, `manifest.json`, `icons/` (as well as `.github/`, `jsconfig.json`) from the CIX context — agents receiving context through CIX do not see those files automatically; read them explicitly when needed.
- The manifest entry works as a pair: `"js": ["src/verdicts.js", "src/cleaner.js"]` in that order, plus `run_at: "document_start"` and `world: "MAIN"` (`manifest.json:20-22`). Reordering the `js` array silently kills the extension (only a `console.error`); dropping `document_start` or the MAIN world lands the hooks where they cannot see the site — the extension silently does nothing.