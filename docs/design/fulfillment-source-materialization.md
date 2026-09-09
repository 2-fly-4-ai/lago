# Fulfillment source materialization (local implementation)

This replaces the quarantined ledger-trigger experiment, not the current payment
execution protocol. Migration 0115 adds only source heads and immutable history.
It adds no writes to existing ledger tables and no payment-table triggers.

The authenticated POST `/api/v1/subscriptions/:externalId/fulfillment-source`
accepts exactly `{ externalCustomerId, invoiceId }`. The configured EPD
organization, account code and network mode are trusted Worker bindings. Callers
cannot select a live/test namespace. The response wrapper is `fulfillmentSource`.
The first invoice anchor is immutable, including after it is refunded. The
invoice/customer/subscription pin is checked inside the D1 transaction, not just
in the route's lookup. A different initial invoice cannot retarget an existing
anchored source. A deleted source retains its original identity for revocation;
reuse of a deleted source ID cannot resurrect it.

Each materialization reads the complete relevant local ledger and updates its
head in one SQL statement. The surrounding D1 batch appends immutable revision
history and returns the same committed head. A changed canonical payload advances
the per-organization/internal-subscription revision; unchanged reads do not.
The database clock supplies production evaluation time. A later evaluation cannot
be replaced by an older caller/test clock. This is local ledger evidence, not a
fresh provider reconciliation.

Coverage uses immutable subscription plan invoice-line periods, not the mutable
subscription period cursor or the invoice link's closed usage period. Successful
mirrored payments/refunds are deduplicated. Contradictory evidence is held.
Confirmed partial refunds preserve coverage; full refunds invalidate only their
invoice. Pending/unknown refunds do not become successful refunds. Independent
newer confirmed paid coverage can remain eligible. Recurring coverage extends
across contiguous paid intervals, never across an unpaid gap. One-time access is
not recurring; an explicit ending date caps its paid-through time.

The payload preserves provider, mode, account, organization, internal/external
customer/subscription identity, normalized email and currency. Identity changes
produce a held inactive payload with the original identity. A future publisher
must not silently treat an identity conflict as a new source.

`listFulfillmentSourcesForRefresh` lists known heads for repair/expiry polling.
It is not scheduled or connected to Auth by this module. Store must combine the
billing revision with its immutable product binding and own its separate Auth
delivery revision. Transport retries, first-purchase discovery, repair cadence,
deployment ordering and provider-backed staging proof remain separate rollout
requirements. No production deployment or external delivery is implied by local
tests.
