import type { AuthContext } from "../auth/api-key";
import { ApiError, json } from "../http";
import { type PaymentRow, paymentRows, serializePayment } from "./payment-ledger";

type ReceiptPaymentRow = {
  receipt_id: string;
  receipt_number: string;
  file_url: string | null;
  xml_url: string | null;
  receipt_created_at: string;
  receipt_version: number;
  payment_id: string;
  payment_organization_id: string;
  payable_id: string;
  payable_type: "Invoice" | "PaymentRequest";
  invoice_ids_json: string;
  invoice_numbers_json: string;
  customer_id: string;
  external_customer_id: string;
  provider: string;
  provider_account_code: string;
  provider_transaction_id: string | null;
  amount_minor: number;
  currency: string;
  payment_status: string;
  payment_type: "provider" | "manual";
  reference: string | null;
  payment_version: number;
  payment_created_at: string;
};

export async function handlePaymentReceiptsApi(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/payment_receipts" && request.method === "GET") {
    return listPaymentReceipts(url, env.BILLING_DB, auth, requestId);
  }
  const resend = url.pathname.match(/^\/api\/v1\/payment_receipts\/([^/]+)\/resend_email$/);
  if (resend?.[1] && request.method === "POST") {
    const id = decodeURIComponent(resend[1]);
    await requiredPaymentReceipt(env.BILLING_DB, auth.organizationId, id);
    throw new ApiError(
      503,
      "payment_receipt_email_disabled",
      "Payment receipt email delivery is not implemented by the Cloudflare billing subset",
    );
  }
  const match = url.pathname.match(/^\/api\/v1\/payment_receipts\/([^/]+)$/);
  if (!match?.[1] || request.method !== "GET") return null;
  const receipt = await requiredPaymentReceipt(
    env.BILLING_DB,
    auth.organizationId,
    decodeURIComponent(match[1]),
  );
  return json({ payment_receipt: serializePaymentReceipt(receipt) }, { requestId });
}

async function listPaymentReceipts(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const page = positivePage(url.searchParams.get("page"));
  const perPage = Math.min(positivePage(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const invoiceId = url.searchParams.get("invoice_id")?.trim() || null;
  const conditions = ["receipt.organization_id = ?"];
  const bindings: unknown[] = [auth.organizationId];
  if (invoiceId) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(payment.invoice_ids_json) WHERE value = ?)");
    bindings.push(invoiceId);
  }
  const where = conditions.join(" AND ");
  const countWhere = where
    .replace("receipt.organization_id", "joined.payment_organization_id")
    .replaceAll("payment.invoice_ids_json", "joined.invoice_ids_json");
  const count = await database
    .prepare(`SELECT COUNT(*) AS total FROM (${receiptPaymentRows()}) joined WHERE ${countWhere}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${receiptPaymentRows()} WHERE ${where}
       ORDER BY receipt.created_at DESC, receipt.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, perPage, offset)
    .all<ReceiptPaymentRow>();
  return json(
    {
      payment_receipts: rows.results.map(serializePaymentReceipt),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function requiredPaymentReceipt(
  database: D1Database,
  organizationId: string,
  id: string,
): Promise<ReceiptPaymentRow> {
  const receipt = await database
    .prepare(`${receiptPaymentRows()} WHERE receipt.organization_id = ? AND receipt.id = ? LIMIT 1`)
    .bind(organizationId, id)
    .first<ReceiptPaymentRow>();
  if (!receipt)
    throw new ApiError(404, "payment_receipt_not_found", "Payment receipt was not found");
  return receipt;
}

function receiptPaymentRows(): string {
  return `SELECT receipt.id AS receipt_id, receipt.number AS receipt_number,
                 receipt.file_url, receipt.xml_url, receipt.created_at AS receipt_created_at,
                 receipt.version AS receipt_version, payment.id AS payment_id,
                 payment.organization_id AS payment_organization_id, payment.payable_id,
                 payment.payable_type, payment.invoice_ids_json, payment.invoice_numbers_json,
                 payment.customer_id, payment.external_customer_id, payment.provider,
                 payment.provider_account_code, payment.provider_transaction_id,
                 payment.amount_minor, payment.currency, payment.status AS payment_status,
                 payment.payment_type, payment.reference, payment.version AS payment_version,
                 payment.created_at AS payment_created_at
          FROM payment_receipts receipt
          JOIN (${paymentRows()}) payment ON payment.id = receipt.payment_id
            AND ((receipt.payment_kind = 'invoice' AND payment.payable_type = 'Invoice')
              OR (receipt.payment_kind = 'payment_request'
                  AND payment.payable_type = 'PaymentRequest'))`;
}

function serializePaymentReceipt(receipt: ReceiptPaymentRow): Record<string, unknown> {
  const payment: PaymentRow = {
    id: receipt.payment_id,
    organization_id: receipt.payment_organization_id,
    payable_id: receipt.payable_id,
    payable_type: receipt.payable_type,
    invoice_ids_json: receipt.invoice_ids_json,
    invoice_numbers_json: receipt.invoice_numbers_json,
    customer_id: receipt.customer_id,
    external_customer_id: receipt.external_customer_id,
    provider: receipt.provider,
    provider_account_code: receipt.provider_account_code,
    provider_transaction_id: receipt.provider_transaction_id,
    amount_minor: receipt.amount_minor,
    currency: receipt.currency,
    status: receipt.payment_status,
    payment_type: receipt.payment_type,
    reference: receipt.reference,
    version: receipt.payment_version,
    created_at: receipt.payment_created_at,
  };
  return {
    lago_id: receipt.receipt_id,
    number: receipt.receipt_number,
    file_url: receipt.file_url,
    xml_url: receipt.xml_url,
    payment: serializePayment(payment),
    created_at: receipt.receipt_created_at,
    version: receipt.receipt_version,
  };
}

function positivePage(value: string | null, fallback = 1): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pagination(total: number, page: number, perPage: number) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < totalPages ? page + 1 : null,
    prev_page: page > 1 && page <= totalPages ? page - 1 : null,
    total_pages: totalPages,
    total_count: total,
  };
}
