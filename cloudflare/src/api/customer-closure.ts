import { ApiError, json } from "../http";
import type { AuthContext } from "../auth/api-key";

export async function holdEmailForClosure(
  database: D1Database,
  auth: AuthContext,
  email: string,
  requestId: string,
) {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 320 || !normalized.includes("@"))
    throw new ApiError(422, "invalid_email", "Email is required");
  await database
    .prepare(
      "INSERT INTO customer_closure_email_holds (organization_id, email) VALUES (?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(auth.organizationId, normalized)
    .run();
  const customers = await database
    .prepare("SELECT external_id FROM customers WHERE organization_id = ? AND lower(email) = ?")
    .bind(auth.organizationId, normalized)
    .all<{ external_id: string }>();
  let ready = true;
  for (const customer of customers.results) {
    if (
      (await holdCustomerForClosure(database, auth, customer.external_id, requestId)).status !== 200
    )
      ready = false;
  }
  return json({ closure: { held: true, ready } }, { status: ready ? 200 : 409, requestId });
}

// Committing this hold serializes against the guarded payment-claim UPDATEs.
// Existing processing/unknown requests are reconciled, never resubmitted.
export async function holdCustomerForClosure(
  database: D1Database,
  auth: AuthContext,
  externalId: string,
  requestId: string,
) {
  const customer = await database
    .prepare("SELECT id FROM customers WHERE organization_id = ? AND external_id = ?")
    .bind(auth.organizationId, externalId)
    .first<{ id: string }>();
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer not found");
  await database
    .prepare(
      "INSERT INTO customer_closure_holds (customer_id, organization_id) VALUES (?, ?) ON CONFLICT(customer_id) DO NOTHING",
    )
    .bind(customer.id, auth.organizationId)
    .run();
  const outstanding = await database
    .prepare(`SELECT (
    (SELECT COUNT(*) FROM easy_pay_direct_payment_executions e
      JOIN payment_request_checkout_intents c ON c.id = e.checkout_intent_id
      WHERE c.customer_id = ? AND e.status IN ('processing', 'unknown')) +
    (SELECT COUNT(*) FROM easy_pay_direct_automatic_payment_executions
      WHERE customer_id = ? AND status IN ('processing', 'unknown'))
    ) AS count`)
    .bind(customer.id, customer.id)
    .first<{ count: number }>();
  return json(
    { closure: { held: true, ready: outstanding?.count === 0 } },
    { status: outstanding?.count === 0 ? 200 : 409, requestId },
  );
}
