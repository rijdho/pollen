# pollen — conventions

Live audience questions on one Cloudflare Worker. Read the root
`Desarrollos/github/CLAUDE.md` first; this file only records what is specific here.

## The one design decision everything else follows from

Every WebSocket message is a billed request. So:

- **The presenter's socket carries the tally**, pushed on every vote. There is one of it.
- **Phones carry the current question only**, pushed when the presenter moves.

That split is also why a question's picture is stored and delivered the way it is, and the
asymmetry is deliberate rather than an oversight:

- **Phones get the picture inline**, riding along with the question push, which happens
  about ten times a session. Zero extra requests.
- **The projected screen fetches it** from `/api/rooms/:code/image?idx=N` and caches it.
  Its socket is the one pushed on every vote, so a hundred kilobytes there would be a
  hundred kilobytes per vote. Ten requests on one device instead.
- **Pictures live in their own SQLite table, not in the question's spec.** `questions()`
  reads every spec and runs on every vote (`scored()`, `vote()`, both views); pictures kept
  in the spec would mean re-reading two megabytes of them each time somebody taps an
  option, on a backend billed by rows and bytes read. This one is easy to undo by accident:
  putting the bytes back into `prepareQuestion`'s spec would work perfectly in a two-person
  test and cost a fortune in a lecture hall.

Pushing results to the room, or letting phones poll, blows the free daily allowance with
a single workshop (the README has the arithmetic). If a change makes the room receive
anything per-vote, it has changed the cost model, not just the feature.

## Three departures from the family, all deliberate

- **The corner radius is 8px / 4px, not the family's 14px / 9px**, and the bars follow it
  rather than being pills. Every other token is identical to the other five tools; this is
  the only value that differs, it was asked for, and it is recorded here so it does not
  read as drift. A full austere variant was built as a prototype behind `?skin=austere` on
  2026-09-10, looked at, judged too far, and deleted whole. Lowering the radius is what
  survived of it. If the family ever moves, move this with it.


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

## A clone cannot end up using this deployment

Three independent things stop it, and none relies on the other two:

1. **Every URL in the browser is relative.** `fetch(path)`, `new URL(path, location.href)`
   and `location.origin` for the join and recovery links. Nothing names a host.
2. **`connect-src 'self'`** in `public/_headers`. A hardcoded absolute URL added by mistake
   is refused by the browser before the code gets a say. `tests/assets.test.mjs` pins the
   directive to exactly `'self'`.
3. **The API sends no CORS headers.** Even with the policy loosened, another origin's page
   gets no usable reply.

Verified on 2026-09-10 by trying to break it: loosening the policy AND hardcoding the
production host still produced only "no connection". `tests/ui.mjs` also records every
request and every WebSocket of a full session and asserts none left the origin, which is
confirmatory rather than primary, and its comment says so.

## It runs in two places, and `server/` is not a second implementation

`npm run serve` runs the whole tool on Node. `server/durable.mjs` provides the Durable
Object interface (`sql.exec`, `setAlarm`, `deleteAll`, `acceptWebSocket`, `getWebSockets`,
`idFromName`, `blockConcurrencyWhile`, `serializeAttachment`, `WebSocketPair`) on top of
`node:sqlite` and `ws`, and `server/index.mjs` imports `worker/src/` **unchanged**.

That is the whole design constraint: one implementation of the room, two platforms. A copy
of the logic in `server/` would drift, and the copy nobody runs before a workshop is the one
that breaks. `tests/portable.test.mjs` fails if `server/` names an application table,
mentions any of the tallying or input functions, or contains a second copy of the security
policy, which it parses from `public/_headers` instead.

Proved rather than claimed: `POLLEN_BASE=http://127.0.0.1:8789 npm run live` and the same
for `npm run ui` pass all 155 and all 69 checks against the Node server, which are the
suites that pass against the Worker.

**The variable is `POLLEN_BASE`.** Every harness reads that name and nothing else, so a run
started with a different one (`POLLEN_ORIGIN`, say) silently falls back to the default
`http://127.0.0.1:8788` and tests the Worker twice while appearing to test both. That
happened on 2026-09-10 and the mistake reached a release note before it was caught. The
cheap check is to look at which process holds each port, rather than trusting the command
line: `lsof -ti :8789 -sTCP:LISTEN | xargs ps -o command=`. `server/index.mjs` takes its
port from `PORT`, not from an argument, so `node server/index.mjs --port 8789` binds 8788
and collides with wrangler.

## Room-typed text and the width of a screen

Every cap in `LIMITS` is a promise about the longest thing somebody can send, and none of
them promises a space. A 200-character prompt, an 80-character option or a 240-character
audience question can be one unbroken word: German compounds are the honest case, a hashtag
or a URL the common one.

A grid or flex item will not shrink below its content unless told to, so an unbreakable word
pushes its container wider, and the page with it. On 2026-09-10 that was true in nine
places at once and had been since each was written. The two halves of the fix always go
together: `minmax(0, 1fr)` (or `min-width: 0`) lets the column shrink, and
`overflow-wrap: anywhere` lets the word break once it has to. Breaking beats clipping, since
a label cut mid-word is unreadable at fifteen metres while a wrapped one is merely taller.

`tests/ui.mjs` pins it, and two things about how it measures are worth keeping:

- **Compare `scrollWidth` with `clientWidth`, never the bounding rectangle.** The first
  version compared rectangles and reported the page clean while the question's own text
  overflowed its box by 2,400 pixels: the box was the right width and only its contents
  were not.
- **Load the page at each width; do not resize into it.** The bars and the cloud size
  themselves in pixels through `element.style` at render time, so resizing without a redraw
  measures a layout computed for the old width. A projector arrives at its size.
- Skip anything inside an `<svg>` and anything with a `clientWidth` of zero. Both report a
  `scrollWidth` that means something else: SVG sizes itself, and the histogram's mean marker
  is a deliberate 0px rule whose label hangs off it.

Three things that cost time when this was built, all in the seam rather than the logic:

- **`stub.fetch()` takes a URL string on Cloudflare**, and the router uses that form for the
  throttle object. The adapter has to wrap it into a `Request` or the first room creation
  dies with "Invalid URL".
- **The upgrade response must expose the socket as `webSocket`**, because that is the
  property the router tests to tell a connection from a payload. Under any other name the
  router wraps the response afresh and the socket is dropped.
- **Node's `Response` refuses status 101**, so the adapter replaces the global with a
  subclass that recognises the upgrade. It is the only global it touches.

## Room lookups are not rate limited, on purpose

Measured against production on 2026-09-10: 25 consecutive lookups of non-existent codes all
answered 404 with nothing throttling them.

Guessing a room is infeasible. 28^6 is 481,890,304, so with five rooms live it takes about
96 million lookups to hit one. What is real is the quota: a scanner at a couple of requests
a second exhausts the free plan's 100,000 a day in about fourteen hours, and the site is
down until it resets.

**Do not answer this with an IP rate limit.** Cloudflare's free plan gives one rule counting
by IP over ten seconds, and the use case here is two hundred people behind one campus NAT
joining within the same ten seconds. A threshold low enough to stop a scanner refuses a
lecture hall, which is the failure that actually matters. An in-Worker limit is worse still:
the request has already been billed by the time the Worker can refuse it.

Rooms are ephemeral, so the damage is a day of unavailability rather than a loss. It is in
the README's caveats. A deployment that needs the guarantee runs on a paid plan or behind
its own edge rules.

## Why there is no database, and what to say when asked

The Durable Object is the storage AND the single point every vote passes through, which is
what makes counting correct without locks and gives the room's WebSockets a home.
Cloudflare's framing: Durable Objects coordinate between clients and give strongly
consistent storage attached to the same object. A database gives the second half only.

The README carries the long answer under "If you want it to store things somewhere else".
The short one, so it is not re-derived:

- **D1 instead of the object** replaces storage and leaves coordination and the sockets
  homeless, so you need a Durable Object anyway and end up with two stores that must agree.
  Do not.
- **Keeping results past the room** is what the question usually means, and it needs a
  webhook, not a database: post the export to a URL the presenter owns, from `Room.alarm()`
  and from the close action. Roughly thirty lines, one new binding, nothing else changes.
  It is the one storage variant worth building and it is not built.
- **Off Cloudflare** is a port, not a setting: `shared/`, `public/` and the tests carry
  over, `worker/src/` is rewritten.

## Two Wrangler configs, and why

`wrangler.toml` is this deployment: it carries the custom domain route and `workers_dev =
false`. `wrangler.self-host.toml` is the same file without those two things, so a clone
deploys to the cloner's own `workers.dev` with no editing.

Two homes for one thing is exactly what the root conventions warn drifts, so
`tests/selfhost.test.mjs` pins them: every line of the real config except the two personal
ones must appear in the self-host one, neither may gain a line the other lacks, and the
Worker must still ask for no binding beyond the two Durable Objects. **A new binding is a
new setup step for everyone self-hosting**, and that test is where it shows up.

The reason "connect it to your own database" has no steps is that there is no database: the
rooms are Durable Objects, created inside whoever's account deploys it. Keep it that way.

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

## Where this is, 2026-09-10

Public, released, deployed and citable. All commits pushed. The deployed files are
byte-identical to the working tree, compared by hash rather than by trusting a deploy log.

    npm test        101 unit tests, no server needed
    npm run dev     wrangler on http://127.0.0.1:8788
    npm run serve   the same tool on Node, no Cloudflare
    npm run live    155 checks against a running server    (needs dev or serve)
    npm run ui      70 checks driving the pages in a browser (needs a server + Chrome)

`npm run ui` and `npm run screenshots` need a Chrome that is not a dependency of this repo:
`npm i puppeteer --no-save`, or point `CHROME_PATH` at one. Deploying runs `npm test` first
but not the other two; run all three, against both platforms, before a release.

**`npm run ui` opens four rooms, and the creation limit is thirty an hour per address.**
Eight runs in an hour exhausts it and the suite stops with a message saying so. Local
Durable Object state lives in `.wrangler/state` and is disposable: deleting it and
restarting `npm run dev` clears the throttle along with every local room.

What exists: five question types (multiple choice, rating scale, ranking, word cloud,
audience questions with support votes), right answers and a scoreboard, server-timed
countdowns, questions added to a live room, saved question sets exportable as a file,
recovery links, results as JSON or CSV, an optional per-question tally on phones, English,
German and Spanish, light and dark. It runs on Cloudflare and on Node from the same code.

Live at `https://pollen.rijdho.org`. Concept DOI `10.5281/zenodo.22685893`, which is the
one to cite and the one on the badge and in the page footer; version DOIs go in the
CHANGELOG under their own release heading.

### Pick up here

1. **Decide whether audience questions should also skip approval.** Word clouds no longer
   wait; audience questions still do, because they are whole sentences rather than one to
   three words. That asymmetry is a judgement call, not an instruction, and it is one line
   in `prepareQuestion` plus the default in `qform.js` if it should go.
2. **A results webhook**, with everything it has to handle written down under "Worth
   building next" below. It is the answer to "can I connect it to my own database".
3. **A full cloud drops its least common words.** They are in the download and the screen
   says how many were left out, but the presenter cannot see them at all.
4. **The scoreboard has no speed bonus.** Doing it honestly means timing arrival at the
   object, never trusting a time a phone reports.
5. **The room cannot attach pictures, only the presenter can.** Asked and answered on
   2026-09-10: an anonymous photograph three metres wide has no moderation story and no
   accountable author, because audience items carry a position rather than a device token
   on purpose. Reopening it means reopening the approval queue that word clouds shed.
6. **A picture is capped at 100 KB and 1280 pixels** (`LIMITS.image`). Chosen with the
   author, and reached by re-encoding in the browser rather than by refusing the file. The
   floor is quality 0.5 in `imagefile.js`; below that text stops being readable, so an
   image that will not fit is refused with a named cause instead.

**Nothing is unreleased.** v1.4.1 is the last tag and everything on `main` is in it. When
the next one is worth a DOI: the concept DOI never changes, and the version DOI replaces
its predecessor in `CITATION.cff` rather than accumulating beside it, because superseded
version DOIs live in the CHANGELOG under their own release heading.

Done and not worth redoing: the leak sweep over the working tree and the full object
history, whose only hits in the entire history are the AGPL's own wording about passwords,
a README sentence saying the room code is not a secret, and a `.gitignore` line; the GitHub
About block; screenshots against the deployed URL; the browser verification of the policy,
done by breaching it; and the entry in `rijdho.github.io/data/cv.json` under `experiments`,
added on 2026-09-10 with the concept DOI.

## The Spanish and German are written, not translated

Every tool in this family writes both without addressing the reader: infinitives,
impersonal `se`, passives, noun phrases. `orcid-finder` says "Encuentra las cuentas ORCID
que declaran una institución" and "Anstellungsdatensätze werden gelesen"; `coara` has a
test named "translated planText stays free of second-person address".

This catalogue was originally produced by translating the English sentence by sentence,
which gave sixteen Spanish strings in the usted imperative, twenty-nine German ones with
Sie, Ihr or Bitte, and calques like "vea llegar las respuestas" and "el borde de la red".
Rewritten on 2026-09-10, and `tests/i18n.test.mjs` fails if either form comes back. The
English does address the reader, on purpose, because it is the original and not a
translation of anyone's grammar; a third test records that so the first two do not look
like a double standard.

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
