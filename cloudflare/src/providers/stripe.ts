import { ApiError } from "../http";

export const STRIPE_API_VERSION = "2026-06-24.dahlia";
const STRIPE_REFUNDS_URL = "https://api.stripe.com/v1/refunds";
const STRIPE_PAYMENT_INTENTS_URL = "https://api.stripe.com/v1/payment_intents";
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

export type StripeRefundEnv = {
  STRIPE_NETWORK_MODE?: string;
  STRIPE_RESTRICTED_API_KEY?: string;
  STRIPE_LIVEMODE_ALLOWED?: string;
};

export type StripeRefundInput = {
  organizationId: string;
  invoiceId: string;
  creditNoteId: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer";
};

export type StripeRefundResult = {
  id: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  failureReason: string | null;
};

export type StripeWalletFundingInput = {
  organizationId: string;
  walletId: string;
  walletTransactionId: string;
  amountMinor: number;
  currency: string;
  paymentMethodId: string;
  idempotencyKey: string;
};

export type StripeWalletFundingResult = {
  id: string;
  status: "pending" | "requires_action" | "processing" | "succeeded" | "failed" | "canceled";
  clientSecret: string | null;
  failureCode: string | null;
  failureMessage: string | null;
};

export async function createStripeWalletFunding(
  env: StripeRefundEnv,
  input: StripeWalletFundingInput,
  fetcher: typeof fetch = fetch,
): Promise<StripeWalletFundingResult> {
  const apiKey = assertStripeTestNetwork(env);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new ApiError(422, "invalid_stripe_wallet_funding", "amountMinor must be positive");
  if (!/^[A-Z]{3}$/.test(input.currency))
    throw new ApiError(422, "invalid_stripe_wallet_funding", "currency must be valid");
  for (const value of [
    input.organizationId,
    input.walletId,
    input.walletTransactionId,
    input.paymentMethodId,
    input.idempotencyKey,
  ])
    if (!value.trim() || value.length > 255)
      throw new ApiError(422, "invalid_stripe_wallet_funding", "Funding identifier is invalid");
  const body = new URLSearchParams({
    amount: String(input.amountMinor),
    currency: input.currency.toLowerCase(),
    payment_method: input.paymentMethodId,
    confirm: "true",
    "payment_method_types[]": "card",
    "metadata[lago_organization_id]": input.organizationId,
    "metadata[lago_wallet_id]": input.walletId,
    "metadata[lago_wallet_transaction_id]": input.walletTransactionId,
  });
  const response = await fetcher(STRIPE_PAYMENT_INTENTS_URL, {
    method: "POST",
    headers: stripeHeaders(apiKey, input.idempotencyKey),
    body,
  });
  const rawBody = await readBoundedResponse(response);
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    throw new ApiError(503, "stripe_invalid_response", "Stripe returned invalid JSON");
  }
  if (!response.ok)
    throw new ApiError(503, "stripe_wallet_funding_failed", stripeErrorMessage(payload));
  const record = asRecord(payload);
  const id = stringValue(record.id);
  const status = normalizePaymentIntentStatus(stringValue(record.status));
  if (!id || !status)
    throw new ApiError(503, "stripe_invalid_response", "Stripe returned incomplete funding");
  const lastError = asRecord(record.last_payment_error);
  return {
    id,
    status,
    clientSecret: stringValue(record.client_secret),
    failureCode: stringValue(lastError.code),
    failureMessage: stringValue(lastError.message),
  };
}

export async function createStripeRefund(
  env: StripeRefundEnv,
  input: StripeRefundInput,
  fetcher: typeof fetch = fetch,
): Promise<StripeRefundResult> {
  if (env.STRIPE_NETWORK_MODE !== "enabled") {
    throw new ApiError(
      503,
      "stripe_network_disabled",
      "Stripe network access is disabled until the production provider gate is approved",
    );
  }
  const apiKey = env.STRIPE_RESTRICTED_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError(503, "stripe_not_configured", "Stripe restricted API key is not configured");
  }
  if (!apiKey.startsWith("rk_test_")) {
    throw new ApiError(
      503,
      "stripe_test_restricted_key_required",
      "Stripe refund execution requires a test-mode restricted API key",
    );
  }
  if (env.STRIPE_LIVEMODE_ALLOWED === "1") {
    throw new ApiError(
      503,
      "stripe_livemode_forbidden",
      "This isolated integration never permits live-mode Stripe execution",
    );
  }
  validateRefundInput(input);

  const body = new URLSearchParams({
    payment_intent: input.paymentIntentId,
    amount: String(input.amountMinor),
    "metadata[lago_organization_id]": input.organizationId,
    "metadata[lago_invoice_id]": input.invoiceId,
    "metadata[lago_credit_note_id]": input.creditNoteId,
  });
  if (input.reason) body.set("reason", input.reason);

  const response = await fetcher(STRIPE_REFUNDS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": input.idempotencyKey,
      "Stripe-Version": STRIPE_API_VERSION,
    },
    body,
  });
  const rawBody = await readBoundedResponse(response);
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    throw new ApiError(503, "stripe_invalid_response", "Stripe returned invalid JSON");
  }
  if (!response.ok) {
    throw new ApiError(503, "stripe_refund_failed", stripeErrorMessage(payload));
  }
  return parseRefund(payload, input.paymentIntentId);
}

function assertStripeTestNetwork(env: StripeRefundEnv): string {
  if (env.STRIPE_NETWORK_MODE !== "enabled")
    throw new ApiError(503, "stripe_network_disabled", "Stripe network access is disabled");
  const apiKey = env.STRIPE_RESTRICTED_API_KEY?.trim();
  if (!apiKey)
    throw new ApiError(503, "stripe_not_configured", "Stripe restricted API key is not configured");
  if (!apiKey.startsWith("rk_test_"))
    throw new ApiError(
      503,
      "stripe_test_restricted_key_required",
      "Stripe execution requires a test-mode restricted API key",
    );
  if (env.STRIPE_LIVEMODE_ALLOWED === "1")
    throw new ApiError(503, "stripe_livemode_forbidden", "Live-mode Stripe is forbidden");
  return apiKey;
}

function stripeHeaders(apiKey: string, idempotencyKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Idempotency-Key": idempotencyKey,
    "Stripe-Version": STRIPE_API_VERSION,
  };
}

function normalizePaymentIntentStatus(
  value: string | null,
): StripeWalletFundingResult["status"] | null {
  if (value === "succeeded" || value === "processing" || value === "requires_action") return value;
  if (value === "canceled") return "canceled";
  if (value === "requires_payment_method") return "failed";
  if (value === "requires_confirmation" || value === "requires_capture") return "pending";
  return null;
}

function validateRefundInput(input: StripeRefundInput): void {
  for (const [name, value] of [
    ["organizationId", input.organizationId],
    ["invoiceId", input.invoiceId],
    ["creditNoteId", input.creditNoteId],
    ["paymentIntentId", input.paymentIntentId],
    ["idempotencyKey", input.idempotencyKey],
  ] as const) {
    if (!value.trim() || value.length > 255) {
      throw new ApiError(422, "invalid_stripe_refund", `${name} is invalid`);
    }
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ApiError(422, "invalid_stripe_refund", "amountMinor must be a positive integer");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new ApiError(422, "invalid_stripe_refund", "currency must be a three-letter code");
  }
}

function parseRefund(payload: unknown, fallbackPaymentIntentId: string): StripeRefundResult {
  const record = asRecord(payload);
  const id = stringValue(record.id);
  const amount = integerValue(record.amount);
  const currency = stringValue(record.currency)?.toUpperCase() ?? null;
  const rawStatus = stringValue(record.status);
  const status = normalizeRefundStatus(rawStatus);
  if (!id || amount === null || !currency || !status) {
    throw new ApiError(503, "stripe_invalid_response", "Stripe returned an incomplete refund");
  }
  return {
    id,
    paymentIntentId: stringValue(record.payment_intent) ?? fallbackPaymentIntentId,
    amountMinor: amount,
    currency,
    status,
    failureReason: stringValue(record.failure_reason),
  };
}

function normalizeRefundStatus(value: string | null): StripeRefundResult["status"] | null {
  if (
    value === "pending" ||
    value === "requires_action" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled"
  )
    return value;
  return null;
}

function stripeErrorMessage(payload: unknown): string {
  const root = asRecord(payload);
  const error = asRecord(root.error);
  return stringValue(error.message) ?? "Stripe rejected the refund request";
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = Number.parseInt(response.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new ApiError(503, "stripe_response_too_large", "Stripe response exceeded the limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new ApiError(503, "stripe_response_too_large", "Stripe response exceeded the limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerValue(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
