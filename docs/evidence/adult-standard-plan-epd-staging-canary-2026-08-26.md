# Adult standard-plan EPD staging canary

Date: 2026-08-26

## Scope

- Store branch: `codex/lago-cloudflare-cutover`
- Lago branch: `codex/cloudflare-native-rewrite`
- Staging only; no live cards, production data, production routes, or production provider calls.
- The Store catalog selects the 988 live adult products in the standard $9 one-time plan cohort.
- Safe products and adult Plus/Premium products remain on the existing Stripe path.

## Deployed versions

- `serp-dev-safe-store`: `5cb0bc63-3c86-4982-847c-10f38c790a27`
- `serp-dev-lago-native`: `b82ac593-ec7b-434a-90c9-f9fb6c1d6315`
- `serp-dev-lago-operator`: `21ed6c7e-49c4-4d57-923d-72470e5384ff`
- `serp-dev-lago-portal`: `6bfeedea-636d-4af4-bcf0-3e20573ab3a0`

## Browser verification

The following staging marketing-site checkouts minted staging-signed intents and reached the Lago EPD
hosted test card form as a one-time `$9.00` purchase:

- `pornhub-video-downloader`
- `eporner-video-downloader`
- `rule34-video-downloader`
- `zzcartoon-downloader`

Each page displayed `EPD TEST MODE`, real hosted card fields, `One-time payment`, and the corrected
`Buy Synthetic Store App Plan` heading. No card was submitted.

Control checks stayed on Stripe Sandbox:

- `pinterest-downloader` on the safe standard plan
- `justforfans-downloader` on the adult Plus plan
- `onlyfans-downloader` on the adult Premium plan

The safe control initially exposed an adult-classification bug. Store commit `8976de4fa` fixed the
route to require both a valid signed standard intent and an adult catalog classification before the
cohort route can select Lago/EPD.

## Automated gates

- Store checkout, billing-route, and migration-journal tests: 34 passed.
- Lago test suite: 72 files and 410 tests passed.
- Lago formatting, lint, generated inventory, Access provisioning tests, generated binding checks,
  TypeScript checks, and development/production dry-run Worker builds passed.
- Unauthenticated operator request redirected to Cloudflare Access (`302`).
- Unauthenticated Lago API request failed closed (`401 unauthorized`).
- Store and Lago health endpoints returned healthy responses.
- Store and Lago D1 `PRAGMA foreign_key_check` returned no rows.
- Lago reported no pending migrations.
- Store migration hashes now match the journal. The previously orphaned row-read index migration was
  moved to journaled migration `0010`, applied to staging, and guarded by a regression test.

## Remote build execution

Builds and deploys ran directly on the Mac mini over the existing `ssh macmini` configuration, using
the mini's local SSD rather than compiling across the SMB-mounted `/Volumes/brianfarley` worktree.
The corrected Store Next build completed in about 35 seconds, and the Lago deploy completed in about
15 seconds. The absolute worktree Git metadata was supplied explicitly where Git-aware commands
needed it.

## Commits

Store:

- `df87d7a53` — route the adult standard-plan staging cohort to EPD
- `8976de4fa` — require adult catalog classification for the cohort
- `0f7f15a03` — repair Store migration journal coverage

Lago:

- `e802ac2` — label one-time EPD purchases truthfully
- `f87f2a5` — scope the upgrade credit ownership assertion

Production routing remains unchanged. Moving any product cohort beyond staging remains a separate
canary decision.
