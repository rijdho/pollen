# pollen — conventions

Live audience questions on one Cloudflare Worker. Read the root
`Desarrollos/github/CLAUDE.md` first; this file only records what is specific here.

## The one design decision everything else follows from

Every WebSocket message is a billed request. So:

- **The presenter's socket carries the tally**, pushed on every vote. There is one of it.
- **Phones carry the current question only**, pushed when the presenter moves.

Pushing results to the room, or letting phones poll, blows the free daily allowance with
a single workshop (the README has the arithmetic). If a change makes the room receive
anything per-vote, it has changed the cost model, not just the feature.

## Two departures from the family, both deliberate

- **The app is served by the Worker, not by GitHub Pages.** Static asset requests are free
  and unlimited, a navigation request does not invoke the script at all, and one origin
  means no CORS and a join URL short enough to read off a wall. The GitHub `homepage`
  points at `pollen.rijdho.org`, not at a Pages site.
- **The Content-Security-Policy is a real header** in `public/_headers`, not a `<meta>`,
  which is the only way to get `frame-ancestors`. Verify it by breaching it in a browser,
  not by reading it.

`style-src` has no `'unsafe-inline'` and must not gain one. Bar widths and word sizes go
through `element.style`, which CSP does not govern; a `style=""` attribute anywhere would
force the policy open and re-admit every injected style attribute with it. A test asserts
the policy has no `unsafe-*`.

## Shared code has one home

`public/js/shared/` is imported by the Worker, by the browser and by the tests. The Worker
bundles it, so the numbers on the projector are the numbers under test. Do not copy a
function into `worker/src/`.

**Every relative import carries `?v=N`, and every N is the same**, Worker included. The
bundler resolves the query fine (checked). A test pins it.

## Where the character folding lives, and why

`shared/sanitize.js` is the boundary between what a participant types and what a room
reads on a wall. Its character classes are built from code points rather than written as
literals, because everything it removes is invisible and a literal would be unreviewable.
Bidirectional overrides are the ones that matter most: they change what is displayed
without changing the string, so a moderator can approve one thing and the room can read
another.

Accents are not folded. `año` and `ano` are different words, and that particular merge is
a joke at the room's expense in letters a foot high.

## Traps already paid for

- **Do not create the SQLite schema in a Durable Object constructor.** A closed room calls
  `deleteAll()` while the instance stays in memory, so a constructor that recreated the
  tables answered 500 instead of 404, and would resurrect a deleted room as an empty shell
  that is billed for its own emptiness. Both objects create their schema lazily.
- **A taken code and unusable questions are different failures.** They shared a 409 once,
  so the router retried five times and answered 503 naming neither. Taken is 409 and worth
  retrying; unusable is 422 and never is.
- **`_headers` rules add rather than replace.** A `Cache-Control` on `/*` and another on
  `/fonts/*` both land on a font and the browser takes the first, so the fonts revalidated
  on every load while the header claimed `immutable`. Only `/fonts/*` sets it.
- **DOM `append()` stringifies its arguments.** A conditional child written as `x && node`
  puts a literal `false` on the page. `el()` in `ui.js` filters falsy children; use it.
- **The voter token must be 8 to 64 characters** of `[A-Za-z0-9_-]`. Shorter is refused
  with `no_voter`, which is a 400 and no broadcast, so a socket read after it hangs.

## Tests

`npm test` is unit only and needs no server. `npm run live` needs `npm run dev` in another
terminal and drives the real runtime: storage, the key gate, both socket kinds, the rate
limit and the creation throttle.

Each live run uses its own `cf-connecting-ip` from the documentation range, because the
creation throttle is real storage with a one-hour window and a fixed address would make
the second run of the day fail on its first room.

The QR fixture in `tests/fixtures/` was verified once by decoding it with an independent
implementation (`zxing-cpp`), which read back the exact URL. **Regenerating it without
decoding the new matrix would make that test vacuous.**

## Still to do before this goes public

Done already: deployed to `pollen.rijdho.org` and verified in a browser (headings at 800,
tabular figures, the policy breached on purpose, and no request to any other origin), and
the GitHub About block is set with description, homepage and six topics.

1. Run the leak sweep over the working tree **and the full history** before flipping
   visibility. The working tree is clean; the history has never been swept.
2. Regenerate the screenshots against the deployed URL, so they stop showing
   `127.0.0.1:8788`: `POLLEN_BASE=https://pollen.rijdho.org npm run screenshots`, which
   opens and then deletes one real room.
3. Connect Zenodo (press **Sync now**, the list is cached), cut v1.0.0, then add the DOI
   badge, `CITATION.cff` and the README `## Citation` section as the closing section.

## Worth doing, not yet done

- **Questions cannot be added to a room that is already open.** The set is fixed when the
  object is created. Appending one is a small admin action plus a broadcast, and it is the
  first thing someone mid-session will want.
- The presenter view has no way back to a room from another device. That is inherent to
  having no accounts, but a printable or copyable recovery link would soften it.
