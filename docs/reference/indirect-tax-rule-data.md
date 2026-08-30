# Indirect Tax Rule Data

The local D1 calculator deliberately separates three concerns:

1. Public rate and boundary data becomes an immutable **draft rule-set artifact**.
2. A human-reviewed activation changes which single rule set is active.
3. Organization registration scopes are entered separately and determine where collection is
   enabled. A published rate never implies that SERP is registered or obligated to collect there.

## Candidate artifact contract

The canonical artifact format is `serp-indirect-tax-rule-set/v1`. The validator requires exact
fields, HTTPS authority references for every rule, canonical UTC timestamps, unique deterministic
identifiers, a lowercase SHA-256 checksum, and `status: draft`. It rejects embedded registration
scopes and cannot render activation SQL.

Run from `cloudflare/`:

```sh
pnpm tax-rules:check
pnpm tax-rules:test
node scripts/indirect-tax-rule-set.mjs checksum fixtures/indirect-tax/candidate-2026-08-31.json
node scripts/indirect-tax-rule-set.mjs render-sql \
  fixtures/indirect-tax/candidate-2026-08-31.json \
  --created-at 2026-08-31T01:00:00.000Z
```

The SQL renderer writes to standard output. It inserts a rule set and its rules as `draft`; it does
not activate anything, create registration scopes, deploy a Worker, or contact a provider. The
rendered file intentionally omits explicit `BEGIN TRANSACTION` and `COMMIT` statements because a
remote Cloudflare D1 file import is already transactional and rejects explicit transaction SQL.

## Current review candidate

`cloudflare/fixtures/indirect-tax/candidate-2026-08-31.json` contains only three country-level
standard-rate candidates for plumbing validation:

- Australia: 10%, referenced to the Australian Taxation Office.
- Great Britain: 20%, referenced to HM Revenue & Customs.
- New Zealand: 15%, referenced to Inland Revenue.

This is not a global production dataset. It is not approved for activation. The generic software
classification (`txcd_10103100`) remains provisional, and each rule explicitly records that both
classification and registration require separate review.

## Intended authoritative-source layers

- United States: [Streamlined Sales Tax rate and boundary files](https://www.streamlinedsalestax.org/Shared-Pages/rate-and-boundary-files/rate-and-boundary-file-updates)
  where available, plus the relevant state authority for gaps. Boundary files and product
  taxability must be reviewed together.
- European Union: the European Commission [Taxes in Europe Database (TEDB) VAT rate service](https://taxation-customs.ec.europa.eu/document/download/d4a05b85-fd95-45a5-95b4-3ef320fa9728_en),
  whose data is supplied by Member States, plus national authority confirmation for the selected
  digital-service classification.
- Other countries: the national tax authority's current publication or machine-readable feed.

Every source adapter must pin the retrieved input checksum, retrieval timestamp, source URL,
effective date, and parser version. A refresh creates a new immutable version; it never updates an
existing rule in place.

### European Union TEDB snapshot

The read-only TEDB adapter requests the national standard VAT rate for all 27 EU member states from
the European Commission's fixed SOAP endpoint. It does not accept a caller-supplied URL. It rejects
redirects, SOAP faults, responses over 5 MiB, incomplete country coverage, ambiguous national
defaults, invalid rates, and noncanonical dates. It maps TEDB's `EL` source code to ISO country code
`GR` while retaining the original source code.

Run from `cloudflare/`:

```sh
pnpm tax-rules:eu-snapshot -- --date 2026-08-31
pnpm tax-rules:check
pnpm tax-rules:priority-candidate
pnpm tax-rules:registration-review
```

The first command performs a read-only retrieval and writes JSON to standard output. The second
validates both the draft rule artifact and the checked-in offline TEDB snapshot. Neither command
writes D1 data, changes a registration, activates collection, or calls Stripe.

The third command deterministically builds a canonical draft candidate for the likely first-wave
market groups: the 27 EU destination countries plus Great Britain, India, South Korea, Mexico, and
Switzerland. It contains separate candidate rules for recurring SaaS electronic downloads and
one-time downloadable software, writes JSON to standard output, and contains no registration
scopes. Its product classifications remain explicitly provisional.

The fourth command creates a separate registration-review artifact. It has no target organization,
registration reference, or effective date, and all six market groups are `disabled` and
`unconfirmed`. This review format is intentionally not accepted by the D1 rule importer.

`cloudflare/fixtures/indirect-tax/eu-tedb-standard-rates-2026-08-31.json` is source evidence, not a
checkout rule set. A standard-rate table does not prove that the generic software product uses that
rate, that SERP is registered to collect it, or that the rate applies to a specific customer.

## Review and activation gates

Before a candidate can become active:

- verify the product classification for the generic software plan;
- verify effective dates, regional boundaries, exemptions, and rounding examples;
- review only the jurisdictions in which the organization is actually registered to collect;
- run bounded comparisons against authority examples and optional Stripe sandbox calculations;
- obtain action-time approval for remote staging migration/data load;
- activate one reviewed version in a separate, explicit transaction.

Production migration, registration changes, collection, provider calls, and deployment remain
separate approval-gated actions.

### Synthetic staging activation

The staging activation renderer accepts only the synthetic E2E organization naming contract and
requires `--acknowledge-staging-only`. It labels every scope as QA-only and not a legal
registration. Generate ignored artifacts under `dist/`; review the rendered SQL before applying it
to `serp-dev-lago-native-d1`:

```sh
pnpm tax-rules:priority-candidate > dist/staging-tax-local/candidate-v2.json
node scripts/indirect-tax-rule-set.mjs render-sql \
  dist/staging-tax-local/candidate-v2.json --created-at <canonical-UTC-ISO> \
  > dist/staging-tax-local/import-v2.sql
pnpm tax-rules:staging-activation -- \
  --organization-id org-synthetic-e2e-20260815-001 \
  --activated-at <same-canonical-UTC-ISO> --acknowledge-staging-only \
  > dist/staging-tax-local/activate-v2.sql
```

This path is for staging QA only. It must not target a production organization or be treated as
proof that the business is registered to collect in any jurisdiction. Before and after applying,
check normalized duplicate identities, the single-active-set invariant, enabled scope counts,
foreign keys, and pending migrations.
