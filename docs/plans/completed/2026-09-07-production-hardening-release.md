# Production checkout hardening release

Status: completed 2026-09-07 (Fiji).

User explicitly approved migrations 0110–0112, an EPD-only write pause and
recovery point, then Lago deployment before Store. No live payment was submitted.

Source: merged PR #5, commit `634709237b52290aeaaeb714cae209b5812c808c`.
Full Lago gate passed; Store CI `34037132951` was green before release mutations.

## Executed sequence

1. Recorded original Worker `81eb2a12-1e32-4593-a20d-5fb7bee5bad5`.
2. Deployed the existing source with EPD live permission `0` as pause version
   `32754f1f-bdbb-47da-861b-bcf7be9c8f13`; verified zero processing executions.
3. Recorded D1 Time Travel bookmark
   `000001d3-000015fa-000050de-2980b8ce76acaa5bb185fdd791124a59` without exporting data.
4. Applied 0110, 0111 and 0112 successfully, preserving payment profile IDs.
5. Deployed `ffc558ae-45df-4090-a368-f6aa652a30ac` to `serp-prod-lago-native`.
6. Confirmed EPD live permission `1`, automatic collection `0`, tax `disabled`,
   no pending migrations and zero foreign-key violations.

`/health` reports production healthy; unauthenticated `/api/v1/customers` returns
401; the operator redirects unauthenticated requests to Cloudflare Access.
Store subsequently deployed `a4129a70-30ad-44e5-9b0f-e53c820e499c`. Its Sprout path
returns this production payment form with the $9 / $4.50 regional discount.
Verification stopped before card entry or charge. Browser automation timed out;
the payment-form check was HTTP-based, not a new browser payment test.

One pre-existing payment execution remains unknown without a provider transaction
reference. It was not retried or declared failed. Preserve evidence for reconciliation.

## Recovery and boundaries

Do not run old EPD write code against the rebuilt profile schema. Roll back Store
first if needed; retain additive tables and payment evidence. D1 restore requires
review of customer activity after the bookmark, not blind restoration.

Cloudflare/Wrangler guidance informed exact environment selection, dry runs,
recovery bookmarks and preservation of existing configuration. No secret changes,
automatic-renewal activation, tax activation or product-canary expansion occurred.
