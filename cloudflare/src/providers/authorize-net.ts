import { ApiError } from "../http";

type HostedPaymentInput = {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  externalCustomerId: string;
  organizationId: string;
  amountMinor: number;
  currency: string;
  customerEmail?: string | null;
};

export type AuthorizeNetEnv = Pick<
  Env,
  | "AUTHORIZE_NET_API_LOGIN_ID"
  | "AUTHORIZE_NET_TRANSACTION_KEY"
  | "AUTHORIZE_NET_ENVIRONMENT"
  | "AUTHORIZE_NET_SUCCESS_REDIRECT_URL"
  | "PUBLIC_BASE_URL"
>;

export type AuthorizeNetTransaction = {
  id: string;
  status: string;
  amountMinor: number | null;
  invoiceNumber: string | null;
  metadata: Record<string, string>;
  failureCode: string | null;
  failureMessage: string | null;
};

const API_URLS = {
  sandbox: "https://apitest.authorize.net/xml/v1/request.api",
  production: "https://api.authorize.net/xml/v1/request.api",
} as const;

const PAYMENT_FORM_URLS = {
  sandbox: "https://test.authorize.net/payment/payment",
  production: "https://accept.authorize.net/payment/payment",
} as const;

export async function createAuthorizeNetPaymentUrl(
  env: AuthorizeNetEnv,
  input: HostedPaymentInput,
  fetcher: typeof fetch = fetch,
): Promise<{ paymentUrl: string; token: string; expiresAt: string | null }> {
  const apiLoginId = requiredSecret(env.AUTHORIZE_NET_API_LOGIN_ID, "AUTHORIZE_NET_API_LOGIN_ID");
  const transactionKey = requiredSecret(
    env.AUTHORIZE_NET_TRANSACTION_KEY,
    "AUTHORIZE_NET_TRANSACTION_KEY",
  );
  const publicBaseUrl = requiredUrl(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL");
  const successUrl = env.AUTHORIZE_NET_SUCCESS_REDIRECT_URL
    ? requiredUrl(env.AUTHORIZE_NET_SUCCESS_REDIRECT_URL, "AUTHORIZE_NET_SUCCESS_REDIRECT_URL")
    : "https://www.authorize.net/";
  const environment = env.AUTHORIZE_NET_ENVIRONMENT === "production" ? "production" : "sandbox";
  const amount = (input.amountMinor / 100).toFixed(2);

  const response = await fetcher(API_URLS[environment], {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      getHostedPaymentPageRequest: {
        merchantAuthentication: { name: apiLoginId, transactionKey },
        transactionRequest: {
          transactionType: "authCaptureTransaction",
          amount,
          order: {
            invoiceNumber: input.invoiceNumber.slice(0, 20),
            description: `Lago invoice ${input.invoiceNumber}`.slice(0, 255),
          },
          customer: {
            id: input.externalCustomerId.slice(0, 20),
            ...(input.customerEmail ? { email: input.customerEmail } : {}),
          },
          userFields: {
            userField: Object.entries({
              lago_invoice_id: input.invoiceId,
              lago_customer_id: input.customerId,
              lago_organization_id: input.organizationId,
              lago_payable_id: input.invoiceId,
              lago_payable_type: "Invoice",
              payment_type: "one-time",
              currency: input.currency,
            }).map(([name, value]) => ({ name, value })),
          },
        },
        hostedPaymentSettings: {
          setting: [
            {
              settingName: "hostedPaymentReturnOptions",
              settingValue: JSON.stringify({
                showReceipt: false,
                url: successUrl,
                cancelUrl: successUrl,
              }),
            },
            {
              settingName: "hostedPaymentButtonOptions",
              settingValue: JSON.stringify({ text: "Pay" }),
            },
            {
              settingName: "hostedPaymentPaymentOptions",
              settingValue: JSON.stringify({ cardCodeRequired: true }),
            },
            {
              settingName: "hostedPaymentSecurityOptions",
              settingValue: JSON.stringify({ captcha: false }),
            },
          ],
        },
      },
    }),
  });

  const rawBody = stripBom(await readBoundedResponse(response, 256 * 1024));
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new ApiError(
      503,
      "authorize_net_invalid_response",
      "Authorize.Net returned invalid JSON",
    );
  }

  const token = typeof body.token === "string" ? body.token : null;
  if (!response.ok || !token) {
    throw new ApiError(503, "authorize_net_error", authorizeNetMessage(body));
  }

  const redirect = new URL("/authorize_net/payment_form", publicBaseUrl);
  redirect.searchParams.set("token", token);
  redirect.searchParams.set("environment", environment);
  return {
    paymentUrl: redirect.toString(),
    token,
    expiresAt: new Date(Date.now() + 14 * 60 * 1000).toISOString(),
  };
}

export async function getAuthorizeNetTransaction(
  env: AuthorizeNetEnv,
  transactionId: string,
  fetcher: typeof fetch = fetch,
): Promise<AuthorizeNetTransaction> {
  const apiLoginId = requiredSecret(env.AUTHORIZE_NET_API_LOGIN_ID, "AUTHORIZE_NET_API_LOGIN_ID");
  const transactionKey = requiredSecret(
    env.AUTHORIZE_NET_TRANSACTION_KEY,
    "AUTHORIZE_NET_TRANSACTION_KEY",
  );
  const environment = env.AUTHORIZE_NET_ENVIRONMENT === "production" ? "production" : "sandbox";
  const response = await fetcher(API_URLS[environment], {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      getTransactionDetailsRequest: {
        merchantAuthentication: { name: apiLoginId, transactionKey },
        transId: transactionId,
      },
    }),
  });

  const rawBody = stripBom(await readBoundedResponse(response, 256 * 1024));
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new ApiError(
      503,
      "authorize_net_invalid_response",
      "Authorize.Net returned invalid JSON",
    );
  }
  const transaction = recordAt(body, "transaction");
  const returnedId = stringAt(transaction, "transId") ?? transactionId;
  const status = stringAt(transaction, "transactionStatus");
  if (!response.ok || !status) {
    throw new ApiError(503, "authorize_net_error", authorizeNetMessage(body));
  }
  const order = recordAt(transaction, "order");
  const responseCode = stringAt(transaction, "responseCode");
  const responseReasonCode = stringAt(transaction, "responseReasonCode");
  const responseReasonDescription = stringAt(transaction, "responseReasonDescription");

  return {
    id: returnedId,
    status,
    amountMinor: decimalToMinor(transaction.authAmount ?? transaction.settleAmount),
    invoiceNumber: stringAt(order, "invoiceNumber"),
    metadata: readUserFields(transaction.userFields),
    failureCode: responseReasonCode ?? responseCode,
    failureMessage: responseReasonDescription,
  };
}

export function normalizeAuthorizeNetPaymentStatus(
  providerStatus: string,
): "pending" | "succeeded" | "failed" | "unknown" {
  if (
    [
      "settledSuccessfully",
      "capturedPendingSettlement",
      "authCaptureTransaction",
      "capture",
    ].includes(providerStatus)
  ) {
    return "succeeded";
  }
  if (["pending", "authorizedHeldForReview"].includes(providerStatus)) return "pending";
  if (["declined", "couldNotVoid", "expired", "failedVoided", "voided"].includes(providerStatus))
    return "failed";
  return "unknown";
}

export function authorizeNetPaymentForm(url: URL): Response {
  const token = url.searchParams.get("token")?.trim();
  if (!token) throw new ApiError(400, "token_required", "Authorize.Net token is required");
  const environment =
    url.searchParams.get("environment") === "production" ? "production" : "sandbox";
  const action = PAYMENT_FORM_URLS[environment];
  const safeToken = escapeHtml(token);
  const safeAction = escapeHtml(action);

  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Redirecting to secure payment</title></head>` +
      `<body><p>Redirecting to secure payment…</p>` +
      `<form id="authorize-net-payment-form" method="post" action="${safeAction}">` +
      `<input type="hidden" name="token" value="${safeToken}">` +
      `<noscript><button type="submit">Continue to payment</button></noscript></form>` +
      `<script nonce="lago-payment-form">document.getElementById('authorize-net-payment-form').submit()</script>` +
      `</body></html>`,
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; form-action https://test.authorize.net https://accept.authorize.net; script-src 'nonce-lago-payment-form'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value?.trim())
    throw new ApiError(503, "provider_not_configured", `${name} is not configured`);
  return value.trim();
}

function requiredUrl(value: string | undefined, name: string): string {
  const candidate = requiredSecret(value, name);
  try {
    return new URL(candidate).toString();
  } catch {
    throw new ApiError(503, "provider_not_configured", `${name} is not a valid URL`);
  }
}

function authorizeNetMessage(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!messages || typeof messages !== "object" || Array.isArray(messages))
    return "Authorize.Net request failed";
  const list = (messages as Record<string, unknown>).message;
  if (!Array.isArray(list)) return "Authorize.Net request failed";
  const first = list[0];
  if (!first || typeof first !== "object" || Array.isArray(first))
    return "Authorize.Net request failed";
  const text = (first as Record<string, unknown>).text;
  return typeof text === "string" && text.trim() ? text : "Authorize.Net request failed";
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value.replace(/^ï»¿/, "");
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number.parseInt(response.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ApiError(
      503,
      "authorize_net_response_too_large",
      "Authorize.Net response exceeded the size limit",
    );
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
      if (total > maxBytes) {
        throw new ApiError(
          503,
          "authorize_net_response_too_large",
          "Authorize.Net response exceeded the size limit",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : {};
}

function stringAt(value: Record<string, unknown>, key: string): string | null {
  const nested = value[key];
  if (typeof nested === "string") return nested.trim() || null;
  if (typeof nested === "number" && Number.isFinite(nested)) return String(nested);
  return null;
}

function decimalToMinor(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const normalized = String(value).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const sign = whole?.startsWith("-") ? -1 : 1;
  const absoluteWhole = Math.abs(Number.parseInt(whole ?? "0", 10));
  const minor = absoluteWhole * 100 + Number.parseInt(fraction.padEnd(2, "0"), 10);
  return Number.isSafeInteger(minor) ? sign * minor : null;
}

function readUserFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const container = value as Record<string, unknown>;
  const fields = Array.isArray(container.userField) ? container.userField : [];
  return Object.fromEntries(
    fields.flatMap((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return [];
      const record = field as Record<string, unknown>;
      const name = stringAt(record, "name");
      const fieldValue = stringAt(record, "value");
      return name && fieldValue !== null ? [[name, fieldValue] as const] : [];
    }),
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}
