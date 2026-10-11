# Code rules (project-specific)

## The verdicts/cleaner seam

- `verdicts.js` and `cleaner.js` are loaded as two content scripts in `manifest.json` in that exact order; `cleaner.js` starts with a guard `var V = window.HhVerdicts; if (!V) return;` (`src/cleaner.js:61-64`). Reordering the `js` array in the manifest silently kills the extension with only a console.error.
- `verdicts.js` must stay side-effect-free (no network/DOM/timers). Anything new that can be expressed as pure functions over list-response data belongs there; it is the file that `test/verdicts.test.js` can run under node via its UMD footer (`src/verdicts.js:50-55, 196-206`).
- `buildChats()` is where `reasons` is born — invariant: `reasons` is always an array, even for empty ones. The historical crash (`undefined.length`, two places computing reasons) is pinned by the first regression test in `test/verdicts.test.js`; don't re-split reason computation.
- Page resources accumulate across a whole scan via `newScan()` + `accumulatePage()` (`src/verdicts.js:184-205`). A chat's topic/vacancy keys can sit on **any** of the ~46 pages; keeping only the last page's resources is the old bug (reasons went silent). Do not "simplify" this to per-page state.

## Decision logic (non-negotiable rules)

- Only `type === "NEGOTIATION"` items are considered; `COMMON` and `SUPPORT` are skipped **even when `operations.allowed` contains `LEAVE_CHAT`** (`COMMON` has it — the type filter is what saves it; test at `test/verdicts.test.js:86-91`).
- "Refusal" = `negotiation_topics[topicId].currentApplicantState === "DISCARD"` (observed values: only RESPONSE/INTERVIEW/DISCARD exist).
- "Archived" = **presence of the `archived` key** on the vacancy object, and the value must have the observed form `{ "@hidden": ... }` (`src/verdicts.js:121-133`). Any other value shape (e.g. plain `true`) means "unsure" → chat untouched. `closedForApplicants` is NOT a proxy — it produced 26 false positives against the mobile API, which is why it is ignored.
- Key presence is checked through `has()` (`src/verdicts.js:64-66`) = `!!obj && Object.prototype.hasOwnProperty.call(obj, key)` — the `hasOwnProperty` call is deliberate defense against a server object with an overridden `hasOwnProperty`.
- `canLeave` = `operations.allowed` contains `LEAVE_CHAT` (`src/verdicts.js:148-151`). Chats that match a reason but lack the operation are counted as "blocked", reported, never sent.

## Network layer (`cleaner.js`)

- All HTTP requests go through `postJSON` (`src/cleaner.js:117-137`) with `credentials: 'include'` and a hard 20 s timeout (`withTimeout`, `REQUEST_MS`, `src/cleaner.js:148-154`) — the timeout is a liveness feature: a stuck scan must fail so the next trigger can restart it, never hang forever.
- `postJSON` sends `Content-Type: application/json`, `Accept: application/json`, `X-Requested-With: XMLHttpRequest` and `X-Xsrftoken` (`src/cleaner.js:117-137`). The token comes from the `_xsrf` cookie, with `window.globalServiceVars.chatik.xsrfToken` as fallback (`src/cleaner.js:105-115`) — both sources are declared optional in `types/global.d.ts` and read defensively.
- `postJSON` parses the body with `r.text()` + `JSON.parse`, not `r.json()` (`src/cleaner.js:128-133`), so a non-JSON answer (error page, gateway text) is caught as a parse error ("нечитаемый ответ") instead of silently mistyping — a read failure, which by the unsure-→-do-nothing rule leaves the chat untouched.
- Leaving is chunked at 20 ids (`LEAVE_CHUNK`) with a 700 ms pause between chunks (`LEAVE_DELAY_MS`) — mirrors the site exactly (`docs/bulk-leave.md` §5.1); do not change sizes/timing.
- Self-trigger guard via `__hhHooked` (fetch/XHR) and `isChatPage` guard (`src/cleaner.js:366`) + `maybeMakeInitRequest` (`src/cleaner.js:387`, 1 init fetch). The XHR hook (`hookXHR`, `src/cleaner.js:405-449`) deliberately has no self-exclusion and is safe only because the extension never uses XHR. Keep any future request additions `fetch`-based.
- Toasts are styled with per-element `style` properties, not a `<style>` tag — page CSP would block injected stylesheets (`src/cleaner.js:160-226`).

## Tests

- The harness is `test()` in `test/verdicts.test.js:30-39` (collects failures, prints `ok`/`FAIL`, exits 1 at the end). Add tests by appending `test('...', () => {...})` blocks; there are no describe/before hooks to match.
- Fixtures in `test/fixtures/live.json` are anonymized real-server excerpts (`_meta` explains it). Synthetic cases must be clearly marked (e.g. the `X`/`Y`/`Z` items in the test file) — they express response shapes that did not occur on the real account.
- `test/` is excluded from `jsconfig.json` — tests are not type-checked; type declarations for browser globals live in `types/global.d.ts` (incl. the `__hhHooked/__hhListRequest` marks on `XMLHttpRequest` and `window.fetch` that hooks set).