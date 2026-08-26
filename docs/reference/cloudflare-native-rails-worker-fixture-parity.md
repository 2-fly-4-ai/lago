# Rails-to-Worker Checkout Fixture Parity

Status: checked-in synthetic contract comparison complete

Last verified: 2026-08-22

This evidence covers the frozen `store-new` Lago checkout contract without reading private data,
starting the legacy container stack, calling a payment provider, or changing either authority. It
does not authorize production-like shadow traffic.

## Compared contract

The four checked-in requests under `cloudflare/fixtures/store-new/` contain synthetic values only.
The executable Worker comparison is `cloudflare/test/compatibility/store-checkout.test.ts`.

| Call | Checked-in fixture | Legacy Rails contract evidence | Worker evidence |
| --- | --- | --- | --- |
| `POST /api/v1/customers` | `customer-upsert.json` | `CustomersController#create` delegates to the API upsert service; its strong parameters accept the fixture's identity, billing configuration, provider code, sync flags, and metadata. `V1::CustomerSerializer` emits the `customer` projection including Lago/external IDs, email, metadata, and billing configuration. | The fixture creates the customer, returns the expected Lago field names, normalizes the synthetic email, and exact replay retains the Lago ID without a duplicate create event. |
| `POST /api/v1/subscriptions` | `subscription-create.json` | `SubscriptionsController#create` accepts the external customer ID, external subscription ID, plan code, and name. `V1::SubscriptionSerializer` emits Lago/external/customer IDs, plan code and amount, status, billing time, period dates, and payment method. | The fixture creates one active calendar subscription and its initial invoice; exact replay retains the Lago ID, while divergent reuse fails with an explicit idempotency conflict. |
| `GET /api/v1/invoices` | `invoice-list-query.json` | `InvoicesController#index` accepts `external_customer_id`; `InvoiceIndex` accepts `per_page`; `V1::InvoiceSerializer` emits the invoice ID, status, payment status, currency, monetary totals, document URLs, timestamps, and optional related projections. | The fixture filters by the synthetic external customer, returns one finalized pending invoice plus pagination metadata, and verifies a positive due amount no greater than the plan amount. |
| `POST /api/v1/invoices/:id/payment_url` | `payment-url-request.json` | The route and `InvoicesController#payment_url` call the payment URL service. `V1::PaymentProviders::InvoicePaymentSerializer` emits exactly the Lago customer ID, external customer ID, provider, Lago invoice ID, and payment URL under `invoice_payment_details`. | With an in-memory Authorize.Net sandbox transport, the fixture verifies amount and non-private Lago metadata, returns the expected hosted URL shape, hashes rather than stores the provider token, and replays without a second provider call. |

Legacy source files inspected:

- `api/config/routes.rb`
- `api/app/controllers/api/v1/customers_controller.rb`
- `api/app/controllers/api/v1/subscriptions_controller.rb`
- `api/app/controllers/api/v1/invoices_controller.rb`
- `api/app/controllers/concerns/invoice_index.rb`
- `api/app/serializers/v1/customer_serializer.rb`
- `api/app/serializers/v1/subscription_serializer.rb`
- `api/app/serializers/v1/invoice_serializer.rb`
- `api/app/serializers/v1/payment_providers/invoice_payment_serializer.rb`
- `api/spec/requests/api/v1/invoices_controller_spec.rb`

## Result and limits

The checked-in Worker test proves the retained consumer-visible subset, root objects, provider
boundary, replay behavior, and failure behavior against non-private fixtures. The Rails source and
request spec confirm that the same routes, accepted fixture parameters, and serialized response
fields are the legacy contract. Worker-only safety fields and explicit conflict errors may be
additive; parity is intentionally defined as preserving the consumer contract, not byte-identical
serialization of every optional Lago field.

This is static legacy-source comparison plus executable Worker validation. A live Rails-versus-
Worker run was intentionally not performed because the legacy test harness requires containers and
is unnecessary to establish the frozen source contract. Read-only production-like shadowing,
production data access, and provider-backed comparison remain separate action-time approvals under
the cutover plan.
