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

## What may reach a phone

`publicQuestion()` in `room.js` is the gate. Which options are right is stripped from every
participant and follower payload until the presenter reveals them; the presenter's own view
rebuilds the full spec. Sending it and not drawing it is not privacy, it is a network panel
away.

The same rule shapes audience questions. Their public id is a plain position within the
question, never anything derived from the asker, because the list is read by the whole
room. `own` is computed per request, so each viewer learns only about their own items.

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
  puts a literal `false` on the page. `el()` filters falsy children and `appendAll()` does
  the same for lists built outside it; never call `node.append(...)` with a maybe-null.
  This reached a screen **three times**. The check added after the second one missed the
  third because it was written for the two pages that happened to be open, which is the
  same mistake as writing a rule for the instance instead of the class. `tests/ui.mjs` now
  fails on any of `null`, `undefined`, `false`, `NaN` or `[object Object]` appearing as a
  word on **every** view, including the home page in both its states: a device with nothing
  saved and one that has opened a room are different branches of the same conditional, and
  only the first was broken.
- **Do not run one `python3 -c` replace across two functions that share a line.** The qa
  and cloud writers had identical `INSERT` statements; an unbounded `.replace` patched both
  and left the cloud path referring to a variable that only exists in the other. It failed
  as a 500 on the next vote, not at parse time.
- **A browser page that holds a WebSocket never reaches `networkidle0`.** Puppeteer waits
  for it forever and the run hangs with no output, because the results were only printed at
  the end. Wait for a selector and print as you go.
- **Never drive a control that opens `confirm()`.** A modal dialog blocks the whole
  automation session. `tests/ui.mjs` ends the room over the API instead.
- **A second tab shares local storage.** The check that a stranger cannot open the presenter
  view passed while proving nothing until it used an isolated browser context.
- **The voter token must be 8 to 64 characters** of `[A-Za-z0-9_-]`. Shorter is refused
  with `no_voter`, which is a 400 and no broadcast, so a socket read after it hangs.

## Tests

Three suites, and they cover different things. `npm test` is unit only and needs no
server. `npm run live` needs `npm run dev` in another terminal and drives the real
runtime: storage, the key gate, both socket kinds, the server clock, the rate limits and
the creation throttle.

Each live run uses its own `cf-connecting-ip` from the documentation range, because the
creation throttle is real storage with a one-hour window and a fixed address would make
the second run of the day fail on its first room.

The QR fixture in `tests/fixtures/` was verified once by decoding it with an independent
implementation (`zxing-cpp`), which read back the exact URL. **Regenerating it without
decoding the new matrix would make that test vacuous.**

## Where this is, 2026-09-09

Working, deployed and private. Eight commits on `main`, all pushed. The deployed files are
byte-identical to the working tree (compared by hash, not by trusting the deploy log).

    npm test        59 unit tests, no server needed
    npm run dev     wrangler on http://127.0.0.1:8788
    npm run live    101 checks against the running Worker   (needs dev)
    npm run ui      23 checks driving the pages in a browser (needs dev + Chrome)

`npm run ui` and `npm run screenshots` need a Chrome that is not a dependency of this repo:
`npm i puppeteer --no-save`, or point `CHROME_PATH` at one. Deploying runs `npm test` first
but not the other two; run all three before a release.

What exists: multiple choice (optionally with a right answer, which turns it into a quiz
with a scoreboard), rating scales, ranking, word clouds and audience questions with support
votes. Countdowns timed by the server. Questions can be added to a live room. Saved question
sets on the device, exportable as a file. Recovery links. Results as JSON or CSV. English,
German and Spanish. Light and dark.

### Pick up here

1. **Decide whether audience questions should also skip approval.** Word clouds no longer
   wait; audience questions still do, because they are whole sentences rather than one to
   three words. That asymmetry was a judgement call, not an instruction, and it is one line
   in `prepareQuestion` plus the default in `qform.js` if it should go.
2. **A full cloud drops its least common words.** They are in the download and the screen
   says how many were left out, but the presenter cannot see them at all. A list behind a
   disclosure, or a smaller minimum size before dropping, would both work.
3. **The scoreboard has no speed bonus.** Doing it honestly means timing arrival at the
   Durable Object, never trusting a time the phone reports.

### Before it goes public

1. Re-run the leak sweep over the working tree **and the full object history**; commits have
   been added since the last one. Run it in `bash` (in `zsh` the `while read` loop yields
   nothing, which reads exactly like a clean repo) and do not call the loop variable `path`,
   which `zsh` binds to `PATH` and empties mid-loop.
2. Regenerate the screenshots against the deployed URL so they stop showing
   `127.0.0.1:8788`: `POLLEN_BASE=https://pollen.rijdho.org npm run screenshots`. It opens
   and then deletes one real room.
3. Connect Zenodo (press **Sync now**; the list is cached), cut v1.0.0, then add the DOI
   badge under the H1, `CITATION.cff`, and the README `## Citation` section last.
4. Add it to `rijdho.github.io/data/cv.json` under `experiments`, where BiblioHelp lives.
   Doing that earlier would publish its existence before the repo is public.

Already done and not worth redoing: deployed and verified in a browser against the live URL
(computed styles, the policy breached on purpose, no request to any other origin); the
GitHub About block set with description, homepage and six topics; and one full-history leak
sweep whose six hits were all read and all benign (the AGPL's own wording about passwords, a
README sentence saying the room code is not a secret, and the `wrangler.toml` comment
stating this Worker is never on the workers.dev namespace).

### One thing that is not this repo's to fix

`life.rijdho.io` has no DNS record, and neither does `rijdho.io`. Every sibling tool links
to `https://rijdho.github.io`, which is what this one now does too. If the personal site is
meant to move, that is a separate job: point the domain, then migrate the footer link in all
six repos at once rather than in this one alone.

## The cloud layout

`shared/cloudlayout.js` places words on an Archimedean spiral and refuses to overlap. Two
properties are load-bearing and both are pinned by tests:

- **Deterministic.** The projected screen redraws on every vote. A layout with any
  randomness in it reshuffles the whole cloud each time, which is unreadable however good
  each frame looks. Positions come from a hash of the word, never from `Math.random`.
- **Never overlapping.** Two words on top of each other are not a flourish, they are a word
  nobody can read. A word that will not fit is reported in `dropped` and the screen says how
  many, rather than being silently lost.

Measurement is injected, so the module has no DOM and the tests use a predictable ruler
instead of depending on how one font happens to render.
