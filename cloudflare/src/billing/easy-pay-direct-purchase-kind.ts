import { ApiError } from "../http";

// The signed request's invoices, not browser input or the generic plan name,
// determine whether the customer is authorizing storage for recurring charges.
export async function easyPayDirectPurchaseKind(
  database: D1Database,
  organizationId: string,
  paymentRequestId: string,
): Promise<"one_time" | "recurring"> {
  const { results } = await database
    .prepare(`SELECT i.subscription_id, s.id AS matched_subscription,
    p.interval FROM invoices_payment_requests link
    JOIN invoices i ON i.id = link.invoice_id AND i.organization_id = link.organization_id
    LEFT JOIN subscriptions s ON s.id = i.subscription_id AND s.organization_id = i.organization_id
    LEFT JOIN plans p ON p.id = s.plan_id AND p.organization_id = s.organization_id
    WHERE link.organization_id = ? AND link.payment_request_id = ?`)
    .bind(organizationId, paymentRequestId)
    .all<{
      subscription_id: string | null;
      matched_subscription: string | null;
      interval: string | null;
    }>();
  const kinds = new Set<string>();
  for (const row of results) {
    if (!row.subscription_id) kinds.add("one_time");
    else if (!row.matched_subscription) kinds.add("invalid");
    else if (row.interval === "one_time") kinds.add("one_time");
    else if (["weekly", "monthly", "quarterly", "yearly"].includes(row.interval ?? ""))
      kinds.add("recurring");
    else kinds.add("invalid");
  }
  if (kinds.size !== 1 || kinds.has("invalid")) {
    throw new ApiError(
      409,
      "easy_pay_direct_purchase_kind_unverified",
      "The purchase billing terms need review before payment.",
    );
  }
  return kinds.has("recurring") ? "recurring" : "one_time";
}
