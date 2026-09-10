# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The Spanish and German were translated from the English rather than
  written.** That produced formal address throughout (16 Spanish strings using
  the usted imperative, 29 German ones with Sie, Ihr or Bitte) and calques like
  "Haga una pregunta a una sala y vea llegar las respuestas" or "in the edge of
  Cloudflare's network". Every other tool in the family writes both languages
  without addressing the reader at all: infinitives, impersonal `se`, passives
  and noun phrases. Both catalogues now do the same, and two tests pin it, with
  a third recording that the English addresses the reader on purpose because it
  is the original.

### Documentation

- Records that room lookups are not rate limited and why that is a choice
  rather than an oversight. Guessing a code is infeasible, but a scanner can
  exhaust the free plan's daily allowance; the obvious defence, an edge rate
  limit per address, would refuse a lecture hall behind one campus NAT, which
  is the failure that actually matters. Measured against production rather than
  assumed.

## [1.1.0] - 2026-09-10

Version DOI: [10.5281/zenodo.22686542](https://doi.org/10.5281/zenodo.22686542)

### Added

- **It runs on Node, not only on Cloudflare.** `npm run serve` starts the whole
  tool on any machine with Node 22.5 or later. `server/` is a platform adapter
  rather than a second implementation: it provides the Durable Object interface
  on top of `node:sqlite`, which ships inside Node, and `ws`, and it imports
  `worker/src/` unchanged, so the room logic, the routing, the rate limits and
  every SQL statement are the same code. Proved by running the same suites
  against it: all 137 live checks and all 45 browser checks pass.
- `tests/portable.test.mjs` keeps it that way. It fails if `server/` names an
  application table, mentions any of the tallying or input functions, or holds a
  second copy of the Content-Security-Policy, which it parses from
  `public/_headers` instead of repeating.

## [1.0.0] - 2026-09-10

Version DOI: [10.5281/zenodo.22685894](https://doi.org/10.5281/zenodo.22685894)

### Added

- The README explains what to do if you want the results stored somewhere
  else, and why the answer is not "add a database": the Durable Object is the
  storage and the point every vote passes through, so swapping in D1 leaves
  coordination and the WebSockets homeless and gives you two stores that must
  agree. The variant actually worth having is a webhook, which needs no
  database, and it is written down as not yet built.
- **A clone can now be deployed.** `wrangler.self-host.toml` is the deployed
  config without the custom domain route, so someone who downloads the
  repository gets a working copy on their own Cloudflare account with
  `npx wrangler deploy -c wrangler.self-host.toml` and no editing. There is
  nothing to connect: storage is Durable Objects, created inside their account,
  and the Worker asks for no other binding, no key and no external service.
  `tests/selfhost.test.mjs` pins the two configs against drift and fails if the
  Worker ever grows a binding, because that would be a new setup step for
  everyone running their own.

- First working version: multiple choice, rating scales and word clouds, with a
  six-character room code and a QR code on the projected screen.
- Word-cloud moderation, on by default, so nothing a participant types reaches
  the projector until the presenter approves it.
- English, German and Spanish, auto-detected and switchable, with a light and
  dark theme.
- Rooms delete themselves after twelve hours, and the presenter can end and
  delete one at any point.
- Rate limiting per device inside a room, and a per-address limit on how many
  rooms can be opened in an hour.
- 45 unit tests over the arithmetic, the text folding, the QR encoder, the
  dictionaries and the asset graph, plus a 56-check script that drives a running
  Worker end to end.

### Added

- **The word cloud is a cloud.** Words are packed on a spiral in
  `shared/cloudlayout.js`, never overlapping, sized and weighted by how often
  they were said, some set vertically, and the drawing is cropped to what was
  placed so it fills the screen. The layout is deterministic, which is the
  property that matters: the screen redraws on every vote, and a cloud that
  reshuffled each time would be unreadable however pretty each frame was.
- **Ranking questions.** Two to eight things put in order, reordered on the
  phone with buttons rather than by dragging, which competes with the page's own
  scrolling and loses. The projector shows the average position each option was
  put in.
- **A per-question setting to show the tally on phones too.** Off by default and
  labelled with what it costs: one extra request per person per question, which
  is linear and affordable, where a live feed to every phone would not be.
- **Results download as CSV** as well as JSON.
- **Audience questions.** The room asks, the room supports each other's, and the
  presenter sees them ordered by support. Moderated by default like the word
  cloud. The list is the one thing a phone fetches rather than receives, so a
  room voting on questions does not multiply the message count by its own size.
- **Quiz mode.** Any multiple-choice question can be given a right answer, which
  makes a scoreboard appear for whoever entered a name. Which options are right
  never reaches a phone until the presenter reveals them.
- **Countdowns.** Any question can be timed. The clock is the server's, so it
  cannot be extended by moving a phone's clock.
- **Questions can be added to a room that is already running**, which was the
  first thing anyone wanted mid-session.
- **Saved question sets.** A set is kept on the device and can be exported as a
  JSON file to carry to another machine or keep as a backup, then imported and
  opened as a room in one click. This is what stands in for an account.
- **Recovery links.** A running room can be reopened on another device. The key
  travels in the URL fragment, which browsers never send to a server, and is
  stripped from the address bar once claimed.
- `npm run ui`, an 18-check script that drives the real pages in a real browser:
  what `npm run live` does for the server contract, this does for the wiring.

### Security

- A security pass, done by attacking it rather than by reading it. Adds
  `tests/security.test.mjs` and an injection section to both the live and the
  browser suites: markup and SQL payloads through every text path, forged and
  malformed voter tokens, admin keys that are near misses, question indices that
  are negative, enormous, fractional or SQL, prototype pollution through the
  creation body and through an imported question set, oversized prompts, and a
  body that is not JSON.
- **A word-cloud entry made only of punctuation was accepted and then silently
  dropped.** It folds to an empty merge key, so the tally discarded it while the
  person who sent it saw a success. It is refused at the point of writing now.
- **The admin key is trimmed on both transports.** HTTP strips whitespace around
  a header value but a query string keeps it, so a recovery link copied with a
  stray space worked one way and failed the other. Whitespace can never be part
  of a key, so trimming gives nothing away.
- Recorded rather than fixed, because it is not a flaw: markup payloads are
  stored and returned exactly as typed, and never escaped. The defence is that
  nothing is ever parsed as markup, and the tests assert that rather than
  asserting escaping, which would have gone green with the real defence removed.
  Planting a real `innerHTML` in the presenter view turns the browser checks
  red; with it planted, the Content-Security-Policy still stopped the injected
  handler from running, which is the second layer doing its job.

- **Right answers no longer leave the room object before the reveal.** They were
  being sent to every phone inside the question spec and merely not drawn, which
  put the answer one network panel away from anyone in the room. The test that
  should have caught it was written as `A || B` with a `B` that was always true,
  so it passed while checking nothing; it is now two assertions, and putting the
  leak back turns them red.
- **The public id of an audience question no longer carries the device that
  asked it.** It was `token:seq`, so the list the whole room reads contained a
  stable per-device identifier and two questions from one person were linkable
  by anyone. It is now a plain position within the question.
- `Strict-Transport-Security` added. Cloudflare does not send it unless it is
  switched on in the dashboard, and nothing here had checked; the header now
  lives in `public/_headers` with the rest of the policy so it travels with the
  repository.
- A room now refuses sockets past seven hundred. Without a ceiling, anyone
  holding a room code could open connections by the thousand, and since every
  connection and every pushed message is a billed request, an open room was a
  way to spend the account's daily allowance.
- The README now states plainly what is defended and what is not, including that
  a script can fill a room to its device ceiling and that no rate limit tight
  enough to stop it would leave a lecture hall able to join.

### Changed

- **Corners are less rounded**: 8px on cards and 4px on controls, where the rest
  of the family uses 14px and 9px, and the bars follow that instead of being
  pills. Every other token is unchanged. A fully austere variant was built as a
  prototype, looked at and rejected as too far; this is what survived of it.
- **Language and theme now look like the rest of the family.** Language is a row
  of mono codes with the current one marked, and theme is a single icon button
  that flips light and dark, copied from `orcid-finder` and `fair-repo-audit`
  rather than approximated. They were two native dropdowns, which was the one
  place this tool did not look like its siblings. The three-way theme choice
  goes with them: the family's control is a toggle.
- **A question's type is now a control, not a label.** The editor opened with a
  multiple choice already placed and no way to change it, so the first question
  was whatever the editor happened to start with unless you deleted it and added
  another. Any question can now be switched, and the prompt survives the switch,
  as do the options where both types have them and the countdown and tally
  settings where both types mean the same thing by them.
- The arrows that reorder questions are disabled at the ends. They used to be
  live and do nothing, which is indistinguishable from a broken button, and the
  position number now sits beside the type it belongs to rather than at the
  other end of the row from the buttons that change it.


- **Word cloud entries no longer wait for approval.** They are one to three
  words, already stripped of anything that could reorder or overflow what is
  displayed, and holding each one turned every cloud into a queue the presenter
  worked through while the room waited. The setting is still there per question,
  off unless asked for. Audience questions still wait by default: whole
  sentences are a different risk.

### Fixed

- The setting that shows results on phones explained its own billing model
  instead of what it does: "it costs one extra request per person per question"
  tells a presenter nothing about their room. It now says the results stay on
  the projected screen unless you turn it on, and that each person then sees
  them on their own phone once they have answered. It also says "results"
  rather than "tally". The cost arithmetic moved to the README, where it is
  useful.


- The creation limit charged for attempts that never opened a room, so a run of
  false starts could lock someone out having successfully created nothing. It is
  now charged only on success, the ceiling is thirty an hour rather than ten, and
  the refusal says how many minutes the wait is.
- The button that opens a room stayed live while the request was in flight, so a
  second click opened a second room.
- The home page printed a literal `null` between two cards on any device that
  had not opened a room. Same `append()` trap as the controls bar below, third
  time it has reached a screen, and the check added for the last one did not
  catch it because it had been written for the two pages that happened to be
  open. It now runs over every view, including the home page in both its states
  and the editor, and putting the defect back turns exactly that one red.
- The home page still said free-text answers are held for approval, which
  stopped being true when word clouds started publishing straight to the screen.
  It now says audience questions wait, which is what happens. The same paragraph
  listed three question types when there are five.
- The controls bar printed a literal `null` where the reveal button belongs on a
  question with no right answer. DOM `append()` stringifies its arguments, and
  this was the second time it reached a screen, so there is now an `appendAll()`
  that filters and a browser check that fails on `null`, `undefined`, `false`,
  `NaN` or `[object Object]` appearing as words on either page.
- The approval queue appeared, saying "nothing waiting", under questions that
  never wait for anything.
- The buttons that add a question sat above the list, out of sight of anyone who
  had just finished typing one. They now sit below it, and each question card is
  numbered.

### Changed

- The footer now signs itself the way every other tool in the family does:
  `by @rijdho · AGPL-3.0 · github`, with the author link pointing at
  `rijdho.github.io`, and a test pins it. It previously read "Built by Ricardo
  Hartley" with no link to the hub at all.

- Typography and tokens brought into line with `fair-repo-audit` and
  `coara-action-planner`: headings at weight 800 with -0.02em tracking and
  `text-wrap: balance`, 15px antialiased body text, eyebrows at .14em, and the
  `--track` and `--shadow` tokens the family defines.
- Every number on the projected screen uses tabular figures, so a percentage
  going from 33 to 44 does not change the width of its row while the room
  watches.
- The three charts redrawn: lettered options with the leader picked out, a
  histogram with the mean drawn where it falls, and a centred cloud whose words
  carry weight as well as size.

### Notes

First public release. The DOI badge, the top-level `doi:` in `CITATION.cff` and
the README's Citation section land in the commit after this one, because Zenodo
does not mint a version DOI until it has processed the GitHub release.
