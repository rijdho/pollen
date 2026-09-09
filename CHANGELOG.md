# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Security

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

### Fixed

- The creation limit charged for attempts that never opened a room, so a run of
  false starts could lock someone out having successfully created nothing. It is
  now charged only on success, the ceiling is thirty an hour rather than ten, and
  the refusal says how many minutes the wait is.
- The button that opens a room stayed live while the request was in flight, so a
  second click opened a second room.
- The buttons that add a question sat above the list, out of sight of anyone who
  had just finished typing one. They now sit below it, and each question card is
  numbered.

### Changed

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

Not released yet: no tag, no Zenodo record and therefore no DOI. The citation
section and the DOI badge arrive with v1.0.0, per the repository conventions.
