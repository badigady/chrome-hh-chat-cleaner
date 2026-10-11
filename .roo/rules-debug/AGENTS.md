# Debug notes (project-specific)

## Logs

- Everything is logged to the page console (F12) with prefix `[hh]`: start + which world ran, every caught list response (status, page path), per-batch summary (chats in response, found count, to-leave), leave progress and outcome.
- `DEBUG = true` at the top of `cleaner.js:82` gates the `dbg()` lines only — `console.log`/`console.warn` lines (leave results, interruptions) are always printed. Set `DEBUG = false` to cut the chatter.
- The first log line reports the execution world: "изолированный мир" vs "главный мир" via `chrome.runtime.id` presence (`cleaner.js:500-503`). It is your first diagnostic: see "worlds" below.

## Why the extension silently does nothing (in order of likelihood)

1. **Wrong world.** Hooks are installed at `document_start` in the content script declared with `world: "MAIN"` (`manifest.json:16-23`). The XHR hook only works where the browser actually runs it in the page's main world (Chrome, Edge). If the browser ignores `world: "MAIN"`, the script runs in the ISOLATED world, the site's XHR/fetch objects are different ones, **no hook ever fires and the extension is completely inert — with no error**, only the startup log saying "изолированный мир". Check that line first. That line is decided by the presence of `window.chrome.runtime.id`: its presence means the script runs in the extension's isolated world (`cleaner.js:500-503`).
2. **Not a chat page.** `processBatch` bails unless `data.__hhOnChatPage` is true (`cleaner.js:277-283`); the flag is set from `isChatPage()` at send time (`cleaner.js:418, 441, 466, 480`). A request not originating from the chat page is skipped ("не уверен").
3. **Queue coalescing.** Only one batch runs at a time (`running = true`); batches arriving mid-run are pushed into `pending[]` (`cleaner.js:284-290`) and processed one by one as the current finishes. This is by design, but it looks like dropped work.
4. **Blocked chats.** If chats match a reason but the server doesn't allow leaving them (no `LEAVE_CHAT` in `operations.allowed`), they are never sent — `canLeave === false` with non-empty `reasons` is a normal state, not an error; the log reports the count (`cleaner.js:306-312`).
5. **Server response not 2xx / not JSON.** The hook skips non-2xx statuses and unparseable bodies (`cleaner.js:424-437, 473-486`) — "не уверен", batch untouched.

## Verifying results

- The leave POST answer IS the truth the extension uses: `applied` is the count of ids accepted by the API (`cleaner.js:241-243`). Re-posting an already-left chat returns 200 with the same `applied` body (idempotent, verified 2026-10-09, `docs/bulk-leave.md` §4.1.1). The extension **does not re-read the chat list** to verify — a human reading "916 → 913" during a live session is an observation, not automatic extension code.
- With `res.applied > 0` the red toast `V.leftMessage(n)` ("Покинуто N чатов") fires (`cleaner.js:339-343`); with zero — green `V.NO_CHATS_MESSAGE` (1 s).
- A "no chats to leave" toast can be a **false negative** if resources weren't accumulated correctly (the 2026-10-09 bug: last-page-only resources → 0 findings on 915 items). If the extension reports nothing to do but the account has DISCARD/archived chats, re-read page-by-page and inspect `scan.resources` (feed it through `V.newScan()` + `V.accumulatePage()`, then check `V.listReasons(item, scan.resources)` per chat) before trusting the verdict; a missing resource key on the page → `listReasons` returns empty → the chat is not left.
- `GET /chat_data?chatId=...` still returns 200 for a left chat — do not use chat detail to verify leaving.

## Environment

- Auth is the browser's own session cookies on hh.ru (`credentials: 'include'`); no tokens needed. Reproducing server behavior requires a logged-in Chrome profile on `hh.ru/chat`.
- `window.globalServiceVars` is injected by the page; in a fresh/framed context it may be absent — both reads of it in `cleaner.js` (getXsrf, `cleaner.js:105-115`) are defensive and return an empty token in that case.
- `types/global.d.ts` exists only for the `tsc -p jsconfig.json` pass; runtime behavior is unaffected by it.
- `.cixignore` hides `.roo/` and `test/` (along with `README.md`, `manifest.json`, `icons/`, `.github/`, `PRIVACY.md`, `jsconfig.json`) from the CIX context — when debugging with context via CIX those files are absent from it; read them explicitly if you need the project rules or fixtures.