# pollen

**Ask a room a question and watch the answers arrive, without anyone signing in to
anything.**

Multiple choice, rating scales and word clouds for a talk or a class. The room joins by
typing a six-character code or pointing a phone at a QR code, answers on the phone, and
the results build up on the projected screen. There is no account, no cookie, no
analytics and no request to any third party. The room deletes itself when the session is
over.

For anyone who runs workshops, lectures or seminars and wants the live-poll part without
handing an audience to a commercial platform.

🔗 **Live:** https://pollen.rijdho.org

Available in **English, German and Spanish** (auto-detected, switchable), with a light
and a dark theme.

![The projected screen during a multiple-choice question. The join address and the room
code fill the left of the header, a QR code sits beside it, and the counter reads 12
answering. Below, the question "Which of these worries you most?" with three lettered
bars: A Cost at 33% with 4 answers, B Time at 25% with 3, and C "Nobody reads it" at 42%
with 5, the leader picked out in violet.](docs/presenter-choice.png)

## What it does

Five kinds of question, added when the room is created or at any point while it is
running:

- **Multiple choice.** Up to eight options, single or multiple selection. Bars with whole
  percentages that add up to exactly 100.
- **Rating scale.** Two to ten steps with labels at each end. Histogram with the mean
  drawn where it actually falls, plus the median and the number of answers.
- **Word cloud.** One to three short entries per person, merged by spelling, then packed on
  a spiral so it reads as a cloud rather than a list. Two words never overlap; one that
  cannot be fitted is reported rather than dropped in silence. The layout is deterministic,
  which matters more than it sounds: the screen redraws on every vote, and a cloud that
  reshuffles each time is unreadable.
- **Ranking.** Two to eight things put in order, reordered on the phone with buttons rather
  than by dragging, which competes with the page's own scrolling and loses. The projector
  shows the average position each one was put in.
- **Audience questions.** The room writes the questions and supports each other's; the
  presenter sees them ordered by support and answers the ones that rise.

Every question's type is a control rather than a label, so the first one is not stuck as
whatever the editor opened with, and a question written as the wrong type can be switched
without losing what is already typed. The arrows beside it reorder the set, and they are
disabled at the ends rather than doing nothing.

![The question editor. The first question is numbered 1 and carries a dropdown reading
"Multiple choice", with an up arrow greyed out, a down arrow and a Remove button on the
right. Below it the question "Which of these worries you most?", two options, and the
settings for right answers, multiple answers, a countdown and showing the tally on
phones.](docs/editor.png)

Any multiple-choice question can be given a right answer, which turns it into a quiz: the
presenter reveals the answer when they choose, and a scoreboard appears for whoever
entered a name. Any question can be given a countdown, timed by the server so it cannot be
extended from a phone.

![The projected screen during audience questions. Four questions from the room, ordered by
support: "How do you fund the repository after the grant ends?" with 3, "What happens to
the data if the platform shuts down?" with 2, "Does this work for a department with no
metadata staff?" with 1, and "Can we reuse your rubric for our own audit?" with none. The
most supported one is picked out in violet.](docs/presenter-qa.png)

![The projected screen during a rating scale. A large violet 3.9 labelled MEAN sits to the
left, with "Median 4 · 12 answers" under it. To the right, five columns headed 0, 1, 2, 6
and 3 answers, the tallest picked out in solid violet, and a black dashed line crossing it
at 3.9.](docs/presenter-scale.png)

The presenter moves the room from one question to the next, can stop and reopen answers,
clear a question, download the results as JSON, or end the session and delete everything.

Results stay on the projector by default. A question can be set to show its tally on the
phones as well; that costs one extra request per person per question, which is affordable,
and the setting says so where it is switched on.

Results download as JSON or as CSV.

![The projected screen during a word cloud. Access, Transparency, Reuse and Funding are the
largest, packed together with smaller words around and between them, several set vertically,
none overlapping.](docs/presenter-cloud.png)

### Keeping your work without an account

The two things an account normally buys are a place to keep your questions and a way back
into your own session. Both are here without one.

A **question set** is saved on your device and can be exported as a JSON file, which is
yours: carry it to another machine, keep it as a backup, or hand it to a colleague. Opening
a room from a set takes one click, and the set is never sent anywhere until you do.

A **recovery link** reopens a running room on another device. The key travels in the URL
fragment, which browsers never send to a server, so it stays out of request lines, out of
edge logs and out of referrers; the page claims it, writes it to that device and strips it
from the address bar. Anyone holding that link controls the room, and the button that
copies it says so.

### What the room types

Whatever a room types goes on a wall in front of everyone, so the two free-text types treat
that differently.

**Word cloud entries go straight to the screen.** They are one to three words, already
folded as below, and holding each one for approval turned every cloud into a queue the
presenter had to work through while the room waited. Approval is still there per question,
off unless asked for, for a room you do not know.

**Audience questions wait for approval by default.** They are whole sentences, long enough
to say something you would not want on a wall, and the presenter is going to read them out
anyway.

Entries are folded before a moderator ever sees them: bidirectional override characters
are stripped, because they reorder what is *displayed* without changing the string, so a
moderator could approve one thing and the room could read another. Zero-width characters
go too, since they let one word masquerade as two. Stacked combining marks are capped so
an entry cannot spill out of its row.

## How it works

One Cloudflare Worker serves the whole thing, and each room is one
[Durable Object](https://developers.cloudflare.com/durable-objects/) holding a small
SQLite database with the questions, the votes and nothing else. When the room's alarm
fires, twelve hours after it opened, the object deletes itself.

```mermaid
graph LR
  accTitle: How a room works
  accDescr: Phones send votes over HTTP to a Worker, which forwards them to one Durable Object per room. The object pushes the running tally to the presenter's screen over a WebSocket, and pushes only the current question to the phones.

  phone[Phones] -->|POST a vote| worker[Worker]
  worker --> room[(Durable Object<br/>one per room)]
  room -->|tally, on every vote| screen[Projected screen]
  room -.->|current question only,<br/>when the presenter moves| phone
  room -->|alarm after 12 hours| gone[deleteAll]
```

The split in that diagram is the whole design. Every WebSocket message is a billed
request, so what is broadcast to the whole room has to be rare:

- the **presenter's** socket gets the full tally on every single vote, and there is one
  of it;
- the **phones** get the current question and nothing else, pushed only when the
  presenter actually moves, which is perhaps ten times in a session.

Phones never receive the running results. That is a deliberate limitation and the reason
this fits in a free plan at all. Audience questions are the one list a phone does see, and
it is **fetched when asked for rather than streamed**, for exactly the same reason: a room
supporting each other's questions changes the list every second or two, and pushing that to
everyone would multiply it by the size of the room.

Which options are right never reaches a phone until the presenter reveals them. Sending
them and simply not drawing them would put the answer one network panel away from anyone in
the room, which on a quiz is the whole game.

### What it costs to run

A workshop of 200 people answering 10 questions, counted against Cloudflare's free daily
allowance of 100,000 requests:

| Approach | Requests for that session | Share of a day |
|---|---:|---:|
| This design | about 6,200 | 6% |
| Phones poll every 3 seconds | about 240,000 | 240% |
| Tally pushed to every phone on every vote | about 400,000 | 400% |

Serving the page itself costs nothing: static asset requests are free and unlimited, and
a navigation request does not invoke the Worker at all, so someone typing the join
address is not a billed request. Durable Objects hibernate between votes, so a room that
sits open through a two-hour session is not billed for the waiting.

### What is stored, and for how long

Per room: the questions, one row per answer, and one row per device that has answered.
The device row holds an opaque token the browser generated for itself, so that a second
answer replaces the first rather than counting twice. No address, no fingerprint, no
account, nothing that identifies a person. The presenter's key to their own room lives in
their browser's local storage and nowhere else.

## Tests

```bash
npm test          # 75 unit tests, no dependencies, Node's own runner
npm run dev       # in one terminal
npm run live      # 137 end-to-end checks against the running Worker
npm run ui        # 42 checks driving the real pages in a real browser
```

The unit tests cover the parts where a silent mistake would still render: percentages
that must sum to 100, a median that has to be a step someone could have chosen, the
character folding above, the QR encoder against a matrix that was verified once by
decoding it with an independent implementation, dictionary parity across the three
languages including the placeholders inside each string, and the module graph's version
pinning.

`npm run live` covers what only the runtime can answer: storage, the key gate, both kinds of
socket, the server-side clock, the rate limits and the creation throttle. `npm run ui`
covers the wiring: that a set saves, that a room opens, that a phone is never handed the
right answer, that the scoreboard fills, and that a recovery link hands the room to a device
that had nothing.

The suite was checked against seventeen deliberately planted defects and killed all of
them, including one round of it that killed only sixteen and exposed a test asserting
something it did not mean. A later check written as `A || B` with a `B` that was always true
passed while proving nothing at all, and was hiding a real leak of the right answers to
every phone in the room; it is now two separate assertions, and putting the leak back turns
them red.

## Run locally

```bash
npm install
npm run dev       # http://127.0.0.1:8788
```

No build step for the browser: the platform serves the files as they are, so what is
deployed is what is in the repository.

## Run your own copy

```bash
git clone https://github.com/rijdho/pollen && cd pollen
npm install
npx wrangler login
npx wrangler deploy -c wrangler.self-host.toml
```

That is the whole setup. **There is no database to connect**, no API key to obtain and no
service to sign up for: the rooms are Durable Objects, created inside your own Cloudflare
account on the first deploy, and the two bindings in the config are the only ones this
Worker has. Nothing in the repository points at anybody else's deployment, and the join
and recovery links are built from wherever it is actually running.

It lands on your own `workers.dev` subdomain. To put it on a domain you own, add a `routes`
block like the one in `wrangler.toml` and set `workers_dev = false`.

Two configs is the shape this repository's own notes warn about, so `tests/selfhost.test.mjs`
fails if they drift: every line of the deployed config except the two personal ones must
appear in the self-host one, and the Worker must still ask for no binding beyond the two
Durable Objects.

## Deploy

```bash
npm run deploy    # runs the tests first, then wrangler deploy
```

The Worker serves its own static assets, which means it can send real response headers
rather than a `<meta>` policy, and therefore carries a `Content-Security-Policy` that
starts at `default-src 'none'` and includes `frame-ancestors`. It was verified in a
browser by trying to breach it: an external `fetch`, a font-CDN stylesheet, an external
script, an inline script and a `style` attribute were all blocked, while the same-origin
WebSocket and `element.style` sizing kept working.

Inter is self-hosted. No font CDN is linked here, ever: it would send every visitor's IP
to that host, and a strict `font-src` blocks it silently anyway.

### What is defended, and what is not

Enforced: a Content-Security-Policy starting at `default-src 'none'` with `frame-ancestors`,
HSTS, `nosniff`, `no-referrer` and a `Permissions-Policy` that turns off every device API;
the admin key compared in constant time; every participant input re-checked and folded on
the server; twenty answers a minute per device; five hundred devices and seven hundred
sockets per room; thirty rooms an hour per address; and no third-party request of any kind,
which is verifiable in a browser's network panel rather than taken on trust.

Not defended, deliberately: **who** is answering. See the first caveat below. The tool also
has no bot detection and no CAPTCHA, because both would mean either a third-party script or
a fingerprint, and this page has neither.

One honest wrinkle: a browser cannot set headers on a WebSocket handshake, so the
presenter's key travels in the query string for that one request. It is otherwise sent as a
header. `Referrer-Policy: no-referrer` keeps it out of referrers, but it can appear in edge
logs, which is a real difference from the header path and is written down here rather than
glossed over.

## Caveats

- **A device token is not an identity.** It stops accidental double voting and gives an
  honest count of how many devices answered. Anyone who wants to vote twice can clear
  their browser storage or open a private window, and anyone willing to write a script can
  mint fresh tokens and fill a room to its 500-device ceiling, whether to stuff the result
  or simply to leave no room for anybody else. Rate limits slow that down; they do not stop
  it. There is no way around it without accounts, and accounts are the thing this tool
  exists to avoid. **Do not use it where the result has consequences.** A limit tight
  enough to stop a script would also turn away a lecture hall arriving at once, which is
  the case this exists to serve, so that trade has been made deliberately and in this
  direction.
- **Anyone with the code can answer.** The code is the only barrier and it is on a screen
  in a public room. It is six characters from a 28-character alphabet, so it cannot
  usefully be guessed from outside, but it is not a secret.
- **Phones do not see the results.** By design, as above. If a room needs everyone to see
  the tally on their own device, this is the wrong tool.
- **A recovery link is the room.** It is not a login, it is the key itself in a URL. Anyone
  who gets hold of it can drive the projector, clear a question or end the session. Send it
  to yourself, not to a channel, and do not put it on a slide.
- **Lose every device, lose the room.** The key lives in local storage and in any recovery
  link you made. There is no account to recover it from, and nobody at the other end can
  restore it.
- **A scoreboard is not an exam.** Names are typed by whoever is holding the phone, one
  device can be handed to someone else, and the device caveat above applies in full. It is
  a game for a room, not an assessment.
- **Moderation is a person, not a filter.** There is no profanity list and no
  classifier. What protects the projector is that someone reads each entry before it
  appears. Leave it on.
- **Twelve hours, then it is gone.** Download the results during or after the session.
  Nothing is recoverable afterwards, including by the person who ran it.
- **A cloud that is full drops words.** When more answers arrive than fit on the screen,
  the least common ones are left out and the screen says how many. They are still in the
  download.
- **Word clouds flatten meaning.** Merging by spelling puts "access" and "Access" in one
  bubble, and leaves "open access" and "access" in two. The size of a word says how often
  it was typed and nothing else.

## License

AGPL-3.0-or-later. Copyright (c) 2026 Ricardo Hartley.

The whole application is served to the browser, so the licence is the only thing that
governs what happens to a copy of it. Section 13 covers use over a network: anyone who
runs a modified version as a service owes its source back to the people using it. Chosen
before the first public commit rather than switched later, because a copy taken under one
licence keeps those terms for good.

The QR encoder in `public/js/vendor/` is Kazuhiko Arase's, under MIT, with its notice
intact.
