# Architecture constraints (project-specific)

## The whole architecture in one sentence

Pure decision layer (`verdicts.js`) over list-response data + I/O layer (`cleaner.js`) in the page's MAIN world, driven only by the site's own list-request loads, with leave counted by `applied` in the POST answer. Everything else follows from this.

## Hard constraints (do not relax without re-reading `README.md` "Правило")

- **One source of truth per pass, zero extra requests.** All criteria live in the single page of `GET /chatik/api/chats` the site itself fetches. No per-chat detail requests, no own pagination deeper than the page the site loaded. Adding a "just one more request" helper breaks the core promise (the extension makes no requests beyond reading list and leaving).
- **No state between runs.** No `localStorage`/IndexedDB/cookies/"already left" lists (stated in `PRIVACY.md` and enforced by design). Re-entrancy is safe because a left chat disappears from the server-side list, so subsequent intercepted list responses simply don't contain it — no need to track the past. Don't introduce caching of verdicts — it would also fight server-side changes that appear mid-session (a vacancy archived while the user is on the page is a case the design explicitly relies on).
- **Irreversible action ⇒ asymmetric error handling.** All uncertainty — unknown item `type`, unknown `archived` value shape, non-JSON response, read failure — resolves to "do nothing", never "proceed". A failed list read aborts the entire pass ("no partial leaving").
- **UI is exactly one transient outcome toast** in a fixed-position container (`#hh-cleaner-toasts`), styled via element `style` to survive page CSP, auto-removed: green ('ok') after 1 s, red ('left') after 5 s. No buttons, panels, system notifications, options — that is a design decision ("unseen" operation), not an omission to fill in.

## Couplings that are not visible from a single file

- `manifest.json` ↔ `cleaner.js`: content script must be `run_at: document_start` + `world: "MAIN"` (`manifest.json:16-23`). `document_start` is required so the XHR/fetch hooks beat the site's first list request; `world: MAIN` is required to touch the site's `XMLHttpRequest`/`fetch` at all. Change either and the extension silently dies.
- `cleaner.js` ↔ `verdicts.js` order in `manifest.json` `content_scripts.js` (verdicts first): `cleaner.js` hard-aborts on missing `window.HhVerdicts`.
- `verdicts.js` ↔ `types/global.d.ts`: the d.ts derives `HhVerdicts` from the UMD export of `verdicts.js` (`import type * as Verdicts from '../verdicts.js'`) precisely to avoid duplicating the API surface — rename a verdicts export and the type check fails there, by design.
- Chunk size 20, 700 ms inter-chunk pause: copied from the site's own bulk-leave behavior (`docs/bulk-leave.md` §5.1, §5.3: site also stops the whole loop on the first chunk error). Diverging risks server-side throttling and changes the failure semantics (unprocessed-vs-rejected counts).

## Deliberate decisions with bug history (don't "simplify")

- `newScan()`/`accumulatePage()` accumulate resources over the WHOLE pass: acceptance found the last page's resources (15 of 915) overwrote earlier ones, making criteria go silent — see tests "регрессия на слияние ресурсов по страницам" (`test/verdicts.test.js:170-216`).
- `reasons` computed once in `buildChats` (was: two places → `undefined.length` crash).
- Single `running` slot + `pending[]` queue (multiple overlapping triggers coalesce to one follow-up pass; this bounded the event storm from the site loading batches every few seconds).
- Self-trigger guard via `__hhHooked` (fetch/XHR) and `maybeMakeInitRequest` (1 init fetch). The XHR hook deliberately has no self-exclusion and is safe only because the extension never uses XHR. Keep any future request additions `fetch`-based.

## Browser-portability fence

Everything above works in browsers that honor `world: "MAIN"` (Chrome, Edge). Firefox does not — the hooks land in the isolated world and never see the site's XHRs (startup log will say "изолированный мир"; extension inert). Supporting more browsers would require a different trigger design, not a flag.

## CIX context

- `.roo/` is listed in `.cixignore` — the project rules (this file and the others in `.roo/`) are **not** part of the standard CIX context, along with `test/`, `README.md`, `manifest.json`, `icons/`. An agent receiving context through CIX does not see them; read them explicitly before touching architecture or rules.