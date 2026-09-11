# EPD API contract comparison

Reviewed: 2026-09-08. Read-only documentation and source inspection; no provider requests,
configuration changes, transactions or deployments in this review.

## Finding

Commerce and Gateway have distinct documented capture/charge contracts. The current Commerce
reference does not document the legacy Gateway-ID import used in this worktree. This is a
contract mismatch, not proof that the merchant account is missing payment capabilities.
An undocumented legacy endpoint might still exist; these docs alone cannot establish its
account-specific behavior or prove the exact cause of a historical transaction failure.

## Primary sources inspected

- [Commerce introduction](https://docs.epd.com/): same API host for live/test; key selects mode;
  Demo Company is the documented source of sandbox keys.
- [Commerce vaulting](https://docs.epd.com/api-reference/card-vaulting): Elements captures a
  single-use `cct_` token, expiring after 15 minutes, attached to a Commerce customer.
- [Commerce payment methods](https://docs.epd.com/api-reference/payment-methods): documented
  attachment body is `card_token`, with optional default/subscription/billing settings, not
  Gateway `billing_id`. Returns a payment-method UUID for orders/subscriptions.
- [Commerce account](https://docs.epd.com/api-reference/account): request version override;
  account version upgrades are one-way. No upgrade performed.
- [Gateway integration portal](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php):
  opened through the authenticated Gateway's own Developer Docs link, not Commerce.
- [Gateway vault variables](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#cv_variables):
  Collect.js `payment_token`, Gateway customer vault and billing identifiers, direct Payment API.
- [Gateway stored credentials](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#credential_on_file_information):
  initial recurring CIT requires recurring billing method, customer initiation, stored indicator;
  later MIT adds original approved transaction ID and uses merchant initiation/used indicator.
  Processor support must also be verified; documentation is not account-specific proof.
- [Gateway testing](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#testing_information):
  per-request test mode and dedicated shared demo account are documented, independent of
  Commerce Demo Company. Example expiry is 10/25, stale relative to this review date; test
  compatibility is not yet proven. Do not toggle the live merchant account's global test mode.
- [Gateway query variables](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#query_variables):
  `api/query.php` supports order and transaction lookup, merchant-defined fields, pagination,
  processor reports and test-mode status. A query is not an idempotency guarantee.
- [Gateway webhook setup](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#webhooks_setup):
  `Webhook-Signature` with `t` and `s`; HMAC-SHA256 over nonce, dot, raw body.
- [Gateway webhook retries](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#webhooks_retry):
  HTTP 200 acknowledgement, bounded retries over approximately three days; schedule not guaranteed.
- [Gateway transaction types](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#transaction_types):
  void before settlement; refund for settled or pending-settlement transactions; credit is a
  separate operation and is not a substitute for a refund.

## Source comparison

`cloudflare/src/providers/easy-pay-direct.ts` in the dirty `codex/epd-vault-binding-repair`
worktree contains:

- Direct Gateway initial sale helper restricted to `gateway_test`; it unconditionally marked
  the request recurring and saved credentials at initial inspection. The local follow-up now
  requires an explicit purchase kind and omits vault/COF fields for one-time purchases. It remains
  test-only; this is not a live-provider acceptance result.
- Direct Gateway renewal helper supporting production/test, with recurring MIT flags and
  original transaction ID.
- Legacy Commerce customer creation carrying `epd_gateway_customer_vault_id`, then payment
  method attachment with `billing_id`, then Commerce order creation.
- Separate uncommitted Elements implementation from the earlier audit. Preserve that work;
  its local test results do not validate the Gateway bridge or establish a deployed solution.

## Recommended direction and remaining proof

Prefer evaluating one coherent Gateway route for existing Gateway credentials and Collect.js:
Lago calculates invoices and owns the schedule; Gateway captures/vaults/charges; no presumed
Gateway-to-Commerce ID import. This is a recommendation, not a deployed architecture change.

Before promotion, finish exact field/response/event mapping, including Collect.js token key
scope, explicit vault billing selection, duplicate-window limitations, ambiguous-response
recovery, original-transaction refund routing, and cancellation fencing. Verify the matching
merchant/processor and sandbox tokenization configuration without exposing secrets.

Then prove initial recurring purchase, later stored-card charge, one-time non-renewal, refund,
decline and timeout recovery through the actual sandbox and the full staging customer journey.
Do not infer readiness from docs, UI access or mock test counts. Production remains approval-gated.

## 2026-09-12 webhook contract correction

The Gateway checkout and renewal path must consume the Gateway webhook contract described above,
not the separate Commerce-style envelope previously implemented by the Worker. The corrected
receiver uses `Webhook-Signature: t=<nonce>,s=<hex digest>`, verifies HMAC-SHA256 over
`<nonce>.<raw body>`, and reads `event_id`, `event_type`, and `event_body`. Gateway
`transaction.sale.success` and `transaction.sale.failure` events are normalized to the existing
payment-reconciliation model using the provider transaction ID, the Gateway `order_id` that Lago
set to its payment-request ID, the requested amount, currency, test-mode evidence, and action
outcome. The raw provider body remains the archived audit artifact.

The Gateway documentation calls `t` a nonce and does not specify the five-minute age rule used by
the old Commerce-style verifier. Replay resistance therefore comes from the signed raw body plus
the durable unique `event_id`; the receiver rejects reuse of an event ID with different content.
Provider-backed receipt delivery is still required before promotion; synthetic contract tests do
not prove that the merchant webhook and signing key are configured.

## Local follow-up (not deployed)

- Gateway-only URL/form/read/charge helpers no longer require a Commerce key. Legacy Commerce
  gates are preserved. This removes a local dependency, not an account permission requirement.
- Initial and renewal approvals checkpoint transaction identity before Query, then require matching
  amount/currency/identity before paid state. Conflicting saved vault identity must remain held
  even on repeated reconciliation. Ambiguous/malformed Query pages cannot be treated as one match.
- Migration 0120 records immutable charge transport. Historical initial payments remain
  `legacy_unknown` unless their existing Elements origin is explicit; no Gateway/Commerce guess
  is made from an ID or today's environment. New executions stamp transport at creation.
- Gateway refunds use a local operation journal (0121), not the original sale ID as a unique refund.
  A durably recorded explicit approval may complete; a lost response remains held without resubmission.
  Aggregate refund totals cannot identify a specific uncertain operation.
- Current documented testing expiry is stale. Dedicated demo testing and the hosted staging journey
  remain unverified until the approved actual provider tests are performed.
