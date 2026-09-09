# Dedicated SERP TEST browser follow-up — 2026-09-09

Status: in progress; no production approval or readiness claim.

## Scope

Only the isolated `serp-dev-lago-epd-serptest` Worker was deployed, version
`a11a1d9b-5b11-47d4-8e41-6376427b3f3b`. Initial payment mutations and provider
reads were enabled for the authorized sandbox test; automatic collection, refund
mode, outbound webhooks, Stripe and cron remained disabled. Existing staging and
production were not changed. A fresh short-lived API identity was generated in
memory, with only its hash stored in isolated D1.

## Browser and checkout evidence

- The user-opened built-in browser tab could be read, reloaded and navigated to
  the fresh checkout. The prior browser block no longer prevents this path.
- The dedicated Gateway UI still showed Test Account and the statement that
  transactions are never sent to a payment processor.
- A fresh fictional monthly subscription generated a pending 900-cent invoice
  and a signed hosted checkout through application APIs.
- Real Collect.js iframes loaded and reported secure fields ready.
- The explicitly fictional zero-tax address fixture produced a 900-cent total.
  This is not evidence of real California tax obligations.
- The first automated card entry was duplicated by masked-input behavior;
  visual inspection revealed it and correction restored the documented test card.
  Tokenization had timed out before a provider execution. D1 count remained zero.
- A timeout left Pay disabled after correction and cleared its error: reproduced
  UI recovery defect, not a confirmed processor decline or charge.

## Local fixes under verification

The existing tax-repriced fixture exposed a separate server error when requesting
its checkout link again. Tax quoting creates the replacement intent under a tax
key; the API attempted a second insert under its canonical key, violating the
unique request-version/provider constraint. Two tests reproduced the D1 failure.
The fix reuses an exact current intent, rejects mismatched or non-successful
states, and explicitly rejects expired URLs without resetting payment evidence.
Focused tax/workflow tests passed 14/14; typecheck, scoped lint and formatting passed.

Account/org scope validation was added before creating or returning a URL. The
first full regression run passed 1011/1012 tests; the remaining Store compatibility
fixture omitted matching configured provider scope. Correcting the fixture (not
weakening the guard) passed all 28 compatibility/tax tests. The following full
`pnpm run check` completed successfully, including the dry-run builds only.

Independent review of the hosted-field recovery found a late-timeout message
could falsely claim no submission after an uncertain response. It also identified
the need to bind tokenization to the total/address at the moment of consent.
These follow-up guards are being tested before the isolated deployment.

## Real provider attempt after UI repair

Deployed isolated version `5bc97998-3d57-42a8-825d-c7648215ecfb` after the
full check passed. Re-requesting the tax-adjusted invoice URL succeeded. Browser
entry was visually verified and submitted once using the documented test card.
The execution received Gateway response code 300: the processor does not permit
overriding its duplicate threshold. Both initial and renewal request builders
were sending `dup_seconds=1200`; removal is under regression review, leaving
merchant defaults and application idempotency intact.

The current execution is conservatively `unknown` with no transaction/vault
checkpoint. The dedicated Test Account report, filtered to its exact order
`19c068c4-a9a3-5b39-a80f-265f1466f268`, all statuses, September 1–8, returned
No Transactions Found. No repeat payment was submitted. Historic execution
evidence is preserved rather than rewritten from an inference.

Official contract: https://docs.nmi.com/reference/transactions-processing
documents `dup_seconds` only for supported processors and response 300 as Gateway
rejection. This processor-specific constraint was absent from the mocks.

The follow-up distinguishes fresh, unambiguous HTTP-success Gateway rejection
from communications/duplicate/conflicting responses. Independent cross-consumer
review found automatic renewals also needed those ambiguity protections so that
dunning cannot turn an unresolved provider outcome into another charge. Existing
unknown evidence is not retroactively terminalized. All changes remain isolated
from production.

## Confirmed real sandbox initial purchases

After the full gate passed again, isolated version
`14343ead-fc31-4610-a3dc-97b7ef2fd217` was deployed. Each fresh checkout was
visually checked, submitted once through real Collect.js and the dedicated
Gateway, and read back from Lago after approval.

- Monthly: invoice `8ea097bc-d855-5998-bb43-afcf0feff9a8`, 900 cents paid,
  Gateway response 100, transaction and vault present, active reusable profile
  with original transaction identity. Fulfillment API: eligible, active, monthly.
- One-time: 956 cents paid (900 plus 56 fictional tax); fulfillment interval
  `one_time`, eligible, zero provider profiles for that fictional customer.
- Discounted monthly: 900 subtotal, 450 discount, 28 fictional tax, 478 paid.
  Coupon was scoped to the specific subscription before creation.
- Decline: the EPD integration portal documents amounts below 1.00 as the test
  decline trigger. A fixture-only 95% coupon produced 45 cents; real browser
  submission returned code 200, execution/invoice failed, fulfillment ineligible.
- Paid-invoice URL replay returned 422 rather than another payable checkout.
- Discounted monthly cancellation was scheduled for its exact paid-period end
  with `on_termination_credit_note=skip`; it remains eligible until that date.
  Omitting that explicit paid-in-advance option was correctly rejected with 422.
  This verifies scheduling/remaining access, not future termination execution.

These are real sandbox transactions with fictional tax fixtures, not real-world
tax-rate validation or production transactions. Stored renewal, refund, deployed
entitlement delivery and Slack are not yet claimed. Direct Lago fixtures do not
establish Store fulfillment.

## Follow-up gaps reproduced before readiness

- A partial refund of the taxed one-time invoice was rejected with 422
  `does_not_match_item_amounts` before any provider refund. The invoice has 56
  cents of collected tax but its refundable fee snapshot has zero tax. The fix
  must preserve historical collected tax and cumulative partial-refund rounding;
  reducing the requested refund would conceal the defect. Existing paid evidence
  will not be silently rewritten; a fresh sandbox purchase will verify the fix.
- The explicitly scoped renewal workflow closed the exact authorized period but
  did not charge the future-due invoice. Workflow
  `sandbox-renewal-5ad4e431-20261001` completed on isolated deployment
  `403985ba-a0ed-4f5a-8b08-1efd09807272`; renewal invoice
  `b03c1cbe-c9d3-56d2-8f96-3096a5e29be5` remains pending at 900 cents with no
  automatic execution. Later inspection of the actual processed-message ledger
  confirmed its invoice event was already published and consumed at 15:03:07 UTC:
  `closeBillingPeriod` does send the event after its transaction. The initial
  missing-dispatch diagnosis was incorrect. The due-date guard was the reason
  no charge was prepared. A scoped resume must reevaluate only this invoice after
  the explicit fixture due-date adjustment, without another billing period.

The full local gate passed 1051 tests before these follow-up edits. That result
is not proof that either newly exposed scenario works. Production remains
untouched and another production canary is not yet justified.

The renewal investigation also confirmed the normal due-date eligibility guard:
the generated invoice is due September 30, so publication alone must not charge
it on September 8 UTC. No production eligibility exception or schema weakening
will be added. The isolated test will explicitly accelerate only this unpaid
fictional invoice's due date, preserving its billing period, payment and vault
evidence. This separates actual stored-card charge proof from natural-calendar
scheduling proof.

Independent Gateway review found no remaining concrete request mismatch for the
fresh approved profile: renewal uses the actual customer vault and original
transaction, omits absent billing ID and keeps test mode enabled. Independent
refund review confirmed Classic EPD supports partial refunds before settlement;
the application never substitutes a full void. Provider readback is still needed
after the actual refund test.

## Follow-up fix verification

The frozen follow-up passed the full `pnpm run check` gate (including all dry-run
builds; no production deployment). Focused receipts: 87 tax/credit-note/document/
Gateway-refund tests and 118 targeted-workflow/automatic-collection tests passed.
Independent review found no blocking defect in the new paid quote attribution
or cumulative refund allocation. The targeted workflow now resumes only its exact
closed cycle and pending linked event; no global outbox drain or second period.

Historical paid invoices without matching fee snapshots deliberately remain held
for reviewed repair. The new code does not silently rewrite past tax evidence.
The real refund retest uses fresh invoice `769a433c-f565-5e11-97c7-cf2f57d5d20f`.

## Real Gateway follow-up receipts (September 8 UTC / September 9 Fiji)

- Exact renewal invoice `b03c1cbe-c9d3-56d2-8f96-3096a5e29be5` paid 900 cents
  through the stored Gateway profile, with one automatic execution. Only this
  unpaid fictional invoice's due date was accelerated; this proves an actual
  stored-card renewal, not natural-calendar scheduling.
- Fresh one-time invoice `769a433c-f565-5e11-97c7-cf2f57d5d20f` paid 956 cents
  (900 base + 56 fictional test tax), Gateway transaction `12530770897`.
  Its fee and invoice tax snapshots both preserve the collected 56 cents.
- Partial credit note `588ed5f4-f07b-50f7-865f-55ca8583d024` requested 478 cents
  (450 base + 28 tax). Operation `0fa04abf-24c0-50ed-a34c-d4f82ece3041` is held
  unknown. Replaying its identical idempotency key returned the same note and
  one operation; fulfillment correctly remains held. Do not resubmit it.
- The Gateway UI shows the original sale pending settlement, without refund or
  void actions. This alone does not resolve an unknown operation.
- Read-only workflow `sandbox-refund-readback-769a433c-v1` on isolated deployment
  `af209b02-1893-45e4-b1f3-1d95af2a9907` reproduced preflight network/body failure.
  A new actual workerd Request-construction test then identified that
  `redirect: "error"` throws immediately in this runtime, before HTTP. Mock fetch
  tests had skipped Request construction. The same option occurs in Elements.
  The fix must use manual redirects and reject all non-success responses without
  following a redirect or exposing credentials. Real Query readback remains to
  be rerun after this fix; the original refund stays held.

The first full gate during this investigation reported 1087/1088 passing while
the new runtime reproduction was intentionally failing. It is not a green gate
and is not deployment approval. Production and shared staging remain untouched.

### Runtime and actual refund contract follow-up

The manual-redirect fix passed 95 focused tests, then the full `pnpm run check`
gate. Isolated deployment `41e6eb83-d9b2-4b04-8db0-7525d3201a08` made the exact
read-only Query succeed: original sale 956 cents, refunded 0. This confirms the
runtime diagnosis rather than merely replacing an error message.

Independent review also hardened malformed action-success values, zero IDs,
duplicate fields and contradictory response codes. Its focused 63 tests and full
gate passed before isolated deployment `b258d36c-a6b1-4d3d-91e7-d629c9c0bf23`.

Fresh browser purchase `7e56d87e-f8eb-53b3-9387-cf6be8d1aca6` paid 956 cents with
56 cents preserved on the fee. Original Gateway sale: `12530894342`.
Partial refund note `e84fe3e2-36ca-542a-8162-efa5a52e1558` succeeded for 478 cents,
operation `a47aaf49-5452-521e-9363-1eef2f7c9a75`, response transaction `12530902591`.
Identical-key replay returned the same note. Lago reports partial refund 478,
pending 0, fulfillment ineligible under its current any-refund policy. This is
Lago projection evidence, not deployed Store/Auth revocation proof.

The Gateway UI independently confirms the approved -4.78 USD refund, pending
settlement. Actual Query differs from the old single-transaction fixture: it
returns the sale plus a separate refund transaction. Read-only workflow
`sandbox-refund-readback-7e56d87e-lineage` on isolated deployment
`62f77d9a-1ff2-4ca8-a0b6-41ec535cde3a` verified sanitized structure:

- Original `12530894342`: USD, pendingsettlement, sale success 1, amount 9.56.
- Child `12530902591`: `original_transaction_id=12530894342`, USD,
  pendingsettlement, refund success 1, amount -4.78.

The existing parser correctly stopped on multiple transaction blocks but lacks
support for this valid provider shape. The remaining 478-cent refund is withheld
until exact-linked child aggregation is implemented and independently reviewed.
Unknown historical operations still cannot be resolved from a matching aggregate.

### Linked refund acceptance and full remainder: passed

Strict linked-transaction support passed 73 focused tests, typecheck, independent
review and the full `pnpm run check` gate. Isolated Worker deployment
`20ad8c08-39df-4c17-b8c8-ab4d5da5e366` is the verified financial-test version.
It requires one original sale, unique IDs, exact child parent linkage, currency,
allowed status, negative approved refund amounts and a cumulative total no larger
than the original. Mixed embedded/child representations and ambiguous records
remain held; no unknown operation is attributed by amount.

- Query-only `sandbox-refund-readback-7e56d87e-fixed`: verified original 956,
  refunded 478 cents.
- Remaining refund note `118b46db-eab4-574e-b681-9d4cd752ea7f`: provider succeeded
  for 478 cents. Its identical-key replay returned the same note.
- Query-only `sandbox-refund-readback-7e56d87e-full`: verified original 956,
  refunded 956 cents. This is actual provider readback, not a mock.
- Lago fulfillment projection: full refund 956, pending 0, eligible false.
- An additional 1-cent request returned 422 `higher_than_remaining_fee_amount`;
  exactly two provider refund operations exist for this invoice.

This proves pending-settlement sandbox refunds, not actual bank settlement or
deployed Store/Auth revocation. Historical unknown operations remain untouched.
The ephemeral API key was revoked and the exact automatic-renewal scope disabled
after the supervised run. The isolated Worker was quiesced with payment,
provider-read, automatic-collection and refund gates disabled and all sandbox
diagnostic pins removed, deployment `ac4f05e2-d7df-4a74-8d78-daee2c92766c`.
D1 readback confirms the scope disabled and the ephemeral key revoked.
Production/shared staging are unchanged.
