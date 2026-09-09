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

### Notes

Not released yet: no tag, no Zenodo record and therefore no DOI. The citation
section and the DOI badge arrive with v1.0.0, per the repository conventions.
