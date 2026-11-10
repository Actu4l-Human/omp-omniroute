# Changelog

## Unreleased

### Fixes

- Correct the pinned Release Please action and document approval-required bot-PR checks.
- Isolate Bun fixture startup from dotenv, inherited credentials, telemetry and host caches.
- Redact normalized usage labels before truncation and prevent account/quota identity collisions.
- Preserve catalog rows with control-only names and avoid reselection caused only by rebuilt header resolver functions.
- Enforce catalog deadlines through the shared bounded GET helper, including fetch/body implementations that ignore cancellation.
- Resolve the development Zod advisory through a scoped Puppeteer 25.x update with its supported BiDi/Zod dependency chain.

### Licensing and documentation

- Adopt AGPL-3.0-or-later with the license included in release packages.
- Document dependency-license obligations, native image-download and pricing limitations, and supported development Node versions.

## [1.5.0](https://github.com/Actu4l-Human/omp-omniroute/compare/v1.4.2...v1.5.0) (2026-11-10)


### Features

* adopt OmniRoute 3.8.54 session attribution, sessions API and budget visibility ([eb4ac5a](https://github.com/Actu4l-Human/omp-omniroute/commit/eb4ac5a98479b4910744b7a4563c6a0e766720dc))


### Bug Fixes

* restore exact SDK pins and exact-scoped Zod override for CI gates ([5dc28c6](https://github.com/Actu4l-Human/omp-omniroute/commit/5dc28c679c4561ee9f4d7d71173c2f096b7e56ce))

## [1.4.2](https://github.com/Actu4l-Human/omp-omniroute/compare/v1.4.1...v1.4.2) (2026-11-09)


### Bug Fixes

* hardened catalog, usage, and Bun test isolation ([e894d7d](https://github.com/Actu4l-Human/omp-omniroute/commit/e894d7d2744b6ccb1a862a1fb74d5d3fb8330704))

## [1.4.1](https://github.com/Actu4l-Human/omp-omniroute/compare/v1.4.0...v1.4.1) (2026-11-08)


### Bug Fixes

* **controls:** refreshed models after transport control changes ([1068183](https://github.com/Actu4l-Human/omp-omniroute/commit/10681835748c86ae2e2de6b707dd556fd84fd83c))

## [1.4.0](https://github.com/Actu4l-Human/omp-omniroute/compare/v1.3.0...v1.4.0) (2026-11-08)


### Features

* added override diagnostics and model update status ([9a6e5c3](https://github.com/Actu4l-Human/omp-omniroute/commit/9a6e5c393c325650526618c2bdfbc05d9af77035))

## [1.3.0](https://github.com/Actu4l-Human/omp-omniroute/compare/v1.2.1...v1.3.0) (2026-11-08)


### Features

* added catalog diagnostics and safer model refresh handling ([6970a5c](https://github.com/Actu4l-Human/omp-omniroute/commit/6970a5cf1d5f05f9a9f8fa137e496a51e2d01c5c))

## [1.2.1](https://github.com/Actu4l-Human/omp-omniroute/compare/v1.2.0...v1.2.1) (2026-11-08)


### Bug Fixes

* avoided redundant model rebinding and hardened cost telemetry ([55c5411](https://github.com/Actu4l-Human/omp-omniroute/commit/55c541158ca97353503fda7e52e9846f96aac979))

## [1.2.0](https://github.com/Actu4l-Human/omp-omniroute/compare/v1.1.0...v1.2.0) (2026-11-08)


### Features

* automate semantic releases and GitHub Packages publishing ([5e219b1](https://github.com/Actu4l-Human/omp-omniroute/commit/5e219b1eca744e49240eb2fd5620f5b3a6ee8c3e))

## Changelog

Release Please adds versioned release notes here from Conventional Commits. The existing `1.1.0` package version is the automation baseline, not a claim that it has been published to GitHub Packages. See [the release process](docs/development.md#releases-and-github-packages).
