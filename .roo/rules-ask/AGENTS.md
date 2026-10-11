# Documentation / context notes (project-specific)

## Where the real documentation lives

- `README.md` is the primary source: both criteria, the "no uncertainty" rule, how it works, the 2026-10-09 live-acceptance results, and the two acceptance bugs. It is more detailed than the code comments in places (e.g. the third auto-left chat story).
- `.github/README.md` is a **shortened marketing copy** of `README.md` (GitHub repo front page). It intentionally omits setup/test details; the two are separate documents, not auto-generated — if you change behavior, check which one each claim belongs to.
- `docs/bulk-leave.md` is the technical spec of `POST /chatik/api/bulk/leave`, with every claim labeled `VERIFIED` / `INFERRED` / `NOT VERIFIED`. Quote it with labels; the important `NOT VERIFIED` items are: the element type inside `rejected`, whether `X-Xsrftoken` is server-mandatory, error bodies/status codes, server-side limits on `chatIds` size.
- The big Russian comment blocks in `src/cleaner.js:1-57` and `src/verdicts.js:1-49` are the canonical in-code description of behavior — they are written at acceptance quality and mirror `README.md`; keep them in sync with behavior changes.

## Misleading names / counterintuitive organization

- `applied` in the `/bulk/leave` response means **"accepted"**, not "performed" (re-post returns the same body). The extension counts leaving by `applied` in the POST answer — it does not re-read the list to verify.
- `reasons` (chat records from `buildChats`) is always an array even when empty; `canLeave === false` with non-empty `reasons` is a normal "server won't let us" state, not an error.
- "Page" = one 20-item cursor batch of the chat list (site pagination), not a browser page load event the extension causes.
- The extension's "triggers" are only: (1) initial entry to the chat page, (2) the site itself loading the next batch. Cursor scrolling by the user without a batch load does nothing — `docs/bulk-leave.md` §5.4 describes the **site's** flow, which the extension merely follows.
- `_display` (title/subtitle) is present on **NEGOTIATION items only** in the list response (COMMON/SUPPORT items lack it) — a fast visual id of a negotiation chat without even reading `type` (`test/fixtures/live.json:16` vs `52-70`).
- `test/fixtures/live.json` is anonymized: ids (5000000001...) and vacancy/company names are synthetic of the same shape; the `UNKNOWN` resource key is real server quirk, not a fixture artifact.
- The repo has **no** `package.json`, no lint config, no CI workflows (`.github/` contains only the README copy) — "no build" is the actual build system: the repo root is the extension itself, all files are first-party and nothing external is bundled.

## History that explains design

- Git log around `5d8356f`/`46a4af8`→`65be326` shows trigger design evolution: scroll/scrollTop polling and debounced triggers were replaced by pure XHR/fetch interception (`65be326`) — the current "listen only to the site's own list request" is the final deliberate version, don't resurrect the old polls.