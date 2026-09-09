import { ApiError } from "../http";
import type { CommerceOrder, EasyPayDirectEnv } from "./easy-pay-direct";
import { requireEasyPayDirectElementsSecretKey } from "./easy-pay-direct-elements-mode";

// Current documented Commerce contract. This deliberately does not import the
// legacy Gateway billing_id/vault bridge.
// https://docs.epd.com/api-reference/customers/
// https://docs.epd.com/api-reference/payment-methods/
type ElementsEnv = Pick<
  EasyPayDirectEnv,
  | "EASY_PAY_DIRECT_COMMERCE_API_KEY"
  | "EASY_PAY_DIRECT_NETWORK_MODE"
  | "EASY_PAY_DIRECT_LIVEMODE_ALLOWED"
> & { APP_ENV?: string };
export type ElementsCustomer = {
  id: string;
  email: string;
  default_payment_method?: string | null;
};
export type ElementsPaymentMethod = {
  id: string;
  customer: string;
  type: "card";
  is_default: boolean;
};
export type ElementsBillingDetails = {
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  email?: string;
  phone?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const maxBytes = 256 * 1024;

function invalid(code = "easy_pay_direct_elements_invalid_response"): never {
  throw new ApiError(503, code, "Payment setup could not be verified. Please contact support.");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function identifier(value: string) {
  if (!uuid.test(value))
    throw new ApiError(
      422,
      "easy_pay_direct_elements_invalid_identifier",
      "Payment setup identifier is invalid.",
    );
}
function email(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized))
    throw new ApiError(
      422,
      "easy_pay_direct_elements_invalid_email",
      "A valid contact email is required.",
    );
  return normalized;
}
function customer(value: unknown, expectedEmail: string, expectedId?: string): ElementsCustomer {
  const row = object(value);
  if (
    typeof row.id !== "string" ||
    !uuid.test(row.id) ||
    (expectedId && row.id !== expectedId) ||
    typeof row.email !== "string" ||
    row.email.trim().toLowerCase() !== email(expectedEmail) ||
    (row.default_payment_method !== undefined &&
      row.default_payment_method !== null &&
      (typeof row.default_payment_method !== "string" || !uuid.test(row.default_payment_method)))
  )
    return invalid();
  return {
    id: row.id,
    email: row.email,
    ...(row.default_payment_method === undefined
      ? {}
      : { default_payment_method: row.default_payment_method as string | null }),
  };
}

async function request(
  env: ElementsEnv,
  path: string,
  options: { method: "GET" | "POST"; body?: unknown; idempotencyKey?: string },
  fetcher: typeof fetch,
): Promise<unknown> {
  const key = requireEasyPayDirectElementsSecretKey(env, env.EASY_PAY_DIRECT_COMMERCE_API_KEY);
  if (
    options.method === "POST" &&
    (!options.idempotencyKey || !uuidV4.test(options.idempotencyKey))
  )
    throw new ApiError(
      422,
      "easy_pay_direct_elements_idempotency_invalid",
      "Payment setup requires a durable UUID v4 request identifier.",
    );
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(`https://api.epd.com/v1${path}`, {
          method: options.method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${key}`,
            "EPD-Version": "2026-02-11",
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(options.idempotencyKey ? { "X-EPD-Idempotency-Key": options.idempotencyKey } : {}),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
        if (controller.signal.aborted) {
          if (response.body) void response.body.cancel().catch(() => undefined);
          throw new ApiError(503, "easy_pay_direct_outcome_unknown", "Payment setup timed out.");
        }
        if (Number(response.headers.get("content-length")) > maxBytes || !response.body)
          return invalid();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        let bytes = 0;
        let raw = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) return invalid();
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
        const body: unknown = JSON.parse(raw);
        if (!response.ok) {
          // Provider messages may contain token/customer data. Never forward them.
          throw new ApiError(
            response.status === 429
              ? 429
              : response.status >= 500 || response.status < 400
                ? 503
                : response.status,
            response.status === 409
              ? "easy_pay_direct_elements_conflict"
              : response.status >= 500
                ? "easy_pay_direct_outcome_unknown"
                : "easy_pay_direct_elements_rejected",
            "Payment setup was not confirmed. Please contact support before trying again.",
          );
        }
        return body;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new ApiError(
              503,
              "easy_pay_direct_outcome_unknown",
              "Payment setup did not return an outcome.",
            ),
          );
        }, 15_000);
      }),
    ]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      503,
      "easy_pay_direct_outcome_unknown",
      "Payment setup did not return a verified outcome.",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

export async function createEasyPayDirectElementsCustomer(
  env: ElementsEnv,
  input: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  },
  fetcher: typeof fetch = fetch,
): Promise<ElementsCustomer> {
  const expectedEmail = email(input.email);
  if (
    !input.firstName.trim() ||
    !input.lastName.trim() ||
    /[<>]/u.test(input.firstName + input.lastName) ||
    !/^\+[1-9]\d{6,14}$/u.test(input.phone)
  )
    throw new ApiError(
      422,
      "easy_pay_direct_elements_contact_invalid",
      "Name and international phone number are required.",
    );
  return customer(
    await request(
      env,
      "/customers",
      {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: {
          email: expectedEmail,
          first_name: input.firstName,
          last_name: input.lastName,
          phone: input.phone,
          metadata: input.metadata,
        },
      },
      fetcher,
    ),
    expectedEmail,
  );
}

export async function retrieveEasyPayDirectElementsCustomer(
  env: ElementsEnv,
  input: { customerId: string; email: string },
  fetcher: typeof fetch = fetch,
): Promise<ElementsCustomer> {
  identifier(input.customerId);
  email(input.email);
  return customer(
    await request(
      env,
      `/customers/${encodeURIComponent(input.customerId)}`,
      { method: "GET" },
      fetcher,
    ),
    input.email,
    input.customerId,
  );
}

export async function findEasyPayDirectElementsCustomerByEmail(
  env: ElementsEnv,
  expectedEmail: string,
  fetcher: typeof fetch = fetch,
): Promise<ElementsCustomer | null> {
  const normalized = email(expectedEmail);
  const query = new URLSearchParams({ email: normalized, limit: "2" });
  const result = object(await request(env, `/customers?${query}`, { method: "GET" }, fetcher));
  if (!Array.isArray(result.data) || result.has_more !== false || result.data.length > 1)
    return invalid("easy_pay_direct_customer_ambiguous");
  return result.data.length === 0 ? null : customer(result.data[0], normalized);
}

export async function addEasyPayDirectElementsPaymentMethod(
  env: ElementsEnv,
  input: {
    customerId: string;
    cardToken: string;
    idempotencyKey: string;
    billingDetails?: ElementsBillingDetails;
  },
  fetcher: typeof fetch = fetch,
): Promise<ElementsPaymentMethod> {
  identifier(input.customerId);
  if (!/^cct_[A-Za-z0-9_-]{8,240}$/u.test(input.cardToken))
    throw new ApiError(
      422,
      "easy_pay_direct_elements_token_invalid",
      "Please enter your payment details again.",
    );
  let billingDetails: ElementsBillingDetails | undefined;
  if (input.billingDetails) {
    billingDetails = {};
    for (const field of [
      "name",
      "address1",
      "address2",
      "city",
      "state",
      "zip",
      "country",
      "email",
      "phone",
    ] as const) {
      const value = input.billingDetails[field];
      if (value === undefined) continue;
      if (
        typeof value !== "string" ||
        !value.trim() ||
        value.length > 254 ||
        (field === "country" && !/^[A-Z]{2}$/u.test(value))
      )
        throw new ApiError(
          422,
          "easy_pay_direct_elements_billing_invalid",
          "Please check your billing address.",
        );
      billingDetails[field] = value;
    }
  }
  const row = object(
    await request(
      env,
      `/customers/${encodeURIComponent(input.customerId)}/payment_methods`,
      {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: {
          card_token: input.cardToken,
          set_as_default: true,
          update_subscriptions: false,
          ...(billingDetails ? { billing_details: billingDetails } : {}),
        },
      },
      fetcher,
    ),
  );
  if (
    typeof row.id !== "string" ||
    !uuid.test(row.id) ||
    row.customer !== input.customerId ||
    row.type !== "card" ||
    row.is_default !== true
  )
    return invalid();
  return { id: row.id, customer: input.customerId, type: "card", is_default: true };
}

export type ElementsProduct = { id: string; pricing: { amount: number; currency: string } };
export type ElementsOrderCheckpoint = { id: string; evidence: unknown };
function money(amountMinor: number, currency: string) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !/^[a-z]{3}$/iu.test(currency))
    throw new ApiError(
      422,
      "easy_pay_direct_elements_amount_invalid",
      "Payment amount could not be verified.",
    );
}
function product(
  value: unknown,
  expected: { productId?: string; amountMinor: number; currency: string },
): ElementsProduct {
  const row = object(value);
  const pricing = object(row.pricing);
  if (
    typeof row.id !== "string" ||
    !uuid.test(row.id) ||
    (expected.productId && row.id !== expected.productId) ||
    pricing.amount !== expected.amountMinor ||
    typeof pricing.currency !== "string" ||
    pricing.currency.toLowerCase() !== expected.currency.toLowerCase() ||
    row.requires_shipping !== false
  )
    return invalid();
  return { id: row.id, pricing: { amount: expected.amountMinor, currency: pricing.currency } };
}

// A per-execution digital product fixes the final amount (including Lago's tax
// and discount computation). Never send a second independent Commerce coupon.
export async function createEasyPayDirectElementsProduct(
  env: ElementsEnv,
  input: {
    name: string;
    description: string;
    amountMinor: number;
    currency: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<ElementsProduct> {
  money(input.amountMinor, input.currency);
  if (
    !input.name.trim() ||
    input.name.length > 250 ||
    !input.description.trim() ||
    input.description.length > 1000 ||
    /[<>\p{Cc}]/u.test(input.name + input.description)
  )
    throw new ApiError(
      422,
      "easy_pay_direct_elements_product_invalid",
      "Payment description is invalid.",
    );
  return product(
    await request(
      env,
      "/products",
      {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: {
          name: input.name,
          description: input.description,
          sku: `serp-${input.idempotencyKey}`,
          pricing: { amount: input.amountMinor, currency: input.currency.toLowerCase() },
          requires_shipping: false,
          metadata: input.metadata,
        },
      },
      fetcher,
    ),
    input,
  );
}

export async function getEasyPayDirectElementsProduct(
  env: ElementsEnv,
  input: { productId: string; amountMinor: number; currency: string },
  fetcher: typeof fetch = fetch,
): Promise<ElementsProduct> {
  identifier(input.productId);
  money(input.amountMinor, input.currency);
  return product(
    await request(
      env,
      `/products/${encodeURIComponent(input.productId)}`,
      { method: "GET" },
      fetcher,
    ),
    input,
  );
}

function checkpoint(value: unknown, expectedId?: string): ElementsOrderCheckpoint {
  const row = object(value);
  if (typeof row.id !== "string" || !uuid.test(row.id) || (expectedId && row.id !== expectedId))
    return invalid();
  return { id: row.id, evidence: value };
}

// POST /orders IS the charge. This function deliberately validates only the
// returned ID. Caller MUST persist it before calling the evidence validator;
// economics/identity failure must never lose the only provider recovery handle.
export async function createEasyPayDirectElementsOrder(
  env: ElementsEnv,
  input: {
    customerId: string;
    paymentMethodId: string;
    productId: string;
    currency: string;
    description?: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<ElementsOrderCheckpoint> {
  identifier(input.customerId);
  identifier(input.paymentMethodId);
  identifier(input.productId);
  if (!/^[a-z]{3}$/iu.test(input.currency))
    throw new ApiError(
      422,
      "easy_pay_direct_elements_amount_invalid",
      "Payment currency is invalid.",
    );
  return checkpoint(
    await request(
      env,
      "/orders",
      {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: {
          customer_id: input.customerId,
          payment_method_id: input.paymentMethodId,
          items: [{ product_id: input.productId, quantity: 1 }],
          currency: input.currency.toLowerCase(),
          ...(input.description ? { description: input.description } : {}),
          metadata: input.metadata,
        },
      },
      fetcher,
    ),
  );
}

export async function getEasyPayDirectElementsOrder(
  env: ElementsEnv,
  orderId: string,
  fetcher: typeof fetch = fetch,
): Promise<ElementsOrderCheckpoint> {
  identifier(orderId);
  return checkpoint(
    await request(env, `/orders/${encodeURIComponent(orderId)}`, { method: "GET" }, fetcher),
    orderId,
  );
}

export function validateEasyPayDirectElementsOrder(
  value: unknown,
  expected: {
    orderId: string;
    customerId: string;
    paymentMethodId: string;
    amountMinor: number;
    currency: string;
  },
): CommerceOrder & { customer_id: string; payment_method: { id: string } } {
  identifier(expected.orderId);
  identifier(expected.customerId);
  identifier(expected.paymentMethodId);
  money(expected.amountMinor, expected.currency);
  const row = object(value);
  const method = object(row.payment_method);
  const statuses = [
    "pending",
    "succeeded",
    "failed",
    "voided",
    "partially_refunded",
    "refunded",
    "refund_failed",
    "chargeback",
    "chargeback_accepted",
    "chargeback_dismissed",
  ];
  if (
    row.id !== expected.orderId ||
    row.customer_id !== expected.customerId ||
    method.id !== expected.paymentMethodId ||
    typeof row.status !== "string" ||
    !statuses.includes(row.status) ||
    row.total !== expected.amountMinor ||
    typeof row.currency !== "string" ||
    row.currency.toLowerCase() !== expected.currency.toLowerCase()
  )
    return invalid();
  let transactions: CommerceOrder["transactions"];
  if (row.transactions !== undefined) {
    if (!Array.isArray(row.transactions)) return invalid();
    transactions = row.transactions.map((value) => {
      const transaction = object(value);
      for (const key of ["id", "type", "status", "processor_transaction_id"])
        if (
          transaction[key] !== undefined &&
          transaction[key] !== null &&
          (typeof transaction[key] !== "string" || transaction[key].length > 256)
        )
          return invalid();
      return {
        ...(typeof transaction.id === "string" ? { id: transaction.id } : {}),
        ...(typeof transaction.type === "string" ? { type: transaction.type } : {}),
        ...(typeof transaction.status === "string" ? { status: transaction.status } : {}),
        ...(typeof transaction.processor_transaction_id === "string"
          ? { processor_transaction_id: transaction.processor_transaction_id }
          : {}),
      };
    });
  }
  return {
    id: expected.orderId,
    customer_id: expected.customerId,
    payment_method: { id: expected.paymentMethodId },
    status: row.status as CommerceOrder["status"],
    total: expected.amountMinor,
    currency: row.currency,
    ...(row.status === "failed" ? { failure_reason: "Payment was declined" } : {}),
    ...(transactions ? { transactions } : {}),
  };
}

export type ElementsRefundResult = {
  id: string | null;
  status: "succeeded" | "failed" | "unknown";
  responseText: string;
};
function unknownRefund(): ElementsRefundResult {
  return {
    id: null,
    status: "unknown",
    responseText: "Refund requires verified transaction evidence",
  };
}

// The documented refund response is the whole order, not proof that this
// specific refund succeeded. Persist the newly observed transaction first and
// then verify its exact order/amount/currency through the transaction endpoint.
// https://docs.api.epd.com/api-reference/orders/#op-refundOrder
// https://docs.api.epd.com/api-reference/transactions/
export async function refundEasyPayDirectElementsOrder(
  env: ElementsEnv,
  input: { orderId: string; amountMinor: number; currency: string; idempotencyKey?: string },
  fetcher: typeof fetch = fetch,
  onTransactionIdentified?: (transactionId: string) => Promise<void>,
): Promise<ElementsRefundResult> {
  identifier(input.orderId);
  money(input.amountMinor, input.currency);
  if (!input.idempotencyKey || !uuidV4.test(input.idempotencyKey))
    throw new ApiError(
      422,
      "easy_pay_direct_elements_idempotency_invalid",
      "Refund requires a durable UUID v4 request identifier.",
    );
  const before = object(
    (await getEasyPayDirectElementsOrder(env, input.orderId, fetcher)).evidence,
  );
  if (
    !Number.isSafeInteger(before.total) ||
    Number(before.total) < input.amountMinor ||
    typeof before.currency !== "string" ||
    before.currency.toLowerCase() !== input.currency.toLowerCase() ||
    !["succeeded", "partially_refunded"].includes(String(before.status)) ||
    !Array.isArray(before.transactions)
  )
    throw new ApiError(
      409,
      "easy_pay_direct_refund_evidence_mismatch",
      "Refund requires verified order evidence.",
    );
  const previousIds = new Set<string>();
  for (const value of before.transactions) {
    const row = object(value);
    if (typeof row.id !== "string" || !uuid.test(row.id) || previousIds.has(row.id))
      throw new ApiError(
        409,
        "easy_pay_direct_refund_evidence_mismatch",
        "Refund requires verified order evidence.",
      );
    previousIds.add(row.id);
  }
  const after = object(
    await request(
      env,
      `/orders/${encodeURIComponent(input.orderId)}/refund`,
      {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: { amount: input.amountMinor },
      },
      fetcher,
    ),
  );
  if (
    after.id !== input.orderId ||
    typeof after.currency !== "string" ||
    after.currency.toLowerCase() !== input.currency.toLowerCase() ||
    !Array.isArray(after.transactions)
  )
    return unknownRefund();
  const refunds = after.transactions
    .filter((value: unknown) => value && typeof value === "object" && !Array.isArray(value))
    .map((value: unknown) => value as Record<string, unknown>)
    .filter(
      (row) =>
        row.type === "refund" &&
        typeof row.id === "string" &&
        uuid.test(row.id) &&
        !previousIds.has(row.id),
    );
  if (refunds.length !== 1) return unknownRefund();
  const transactionId = refunds[0]!.id as string;
  await onTransactionIdentified?.(transactionId);
  return readEasyPayDirectElementsRefundTransaction(env, { ...input, transactionId }, fetcher);
}

export async function readEasyPayDirectElementsRefundTransaction(
  env: ElementsEnv,
  input: { transactionId: string; orderId: string; amountMinor: number; currency: string },
  fetcher: typeof fetch = fetch,
): Promise<ElementsRefundResult> {
  identifier(input.transactionId);
  identifier(input.orderId);
  money(input.amountMinor, input.currency);
  const row = object(
    await request(
      env,
      `/transactions/${encodeURIComponent(input.transactionId)}`,
      { method: "GET" },
      fetcher,
    ),
  );
  if (
    row.id !== input.transactionId ||
    row.type !== "refund" ||
    row.order_id !== input.orderId ||
    row.amount !== input.amountMinor ||
    typeof row.currency !== "string" ||
    row.currency.toLowerCase() !== input.currency.toLowerCase()
  )
    return unknownRefund();
  const status =
    row.status === "succeeded"
      ? "succeeded"
      : row.status === "failed" || row.status === "voided"
        ? "failed"
        : "unknown";
  return {
    id: input.transactionId,
    status,
    responseText:
      status === "succeeded"
        ? "Refund confirmed"
        : status === "failed"
          ? "Refund failed"
          : "Refund outcome is pending",
  };
}
