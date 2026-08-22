import { sha256Hex } from "../auth/api-key";
import { ApiError } from "../http";

const COMMERCE_API_URL = "https://api.epd.com/v1";
const COMMERCE_API_VERSION = "2026-02-11";
const PAYMENT_API_URL = "https://secure.easypaydirectgateway.com/api/transact.php";
const COLLECT_JS_URL = "https://secure.easypaydirectgateway.com/token/Collect.js";
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const CHECKOUT_TTL_SECONDS = 20 * 60;

export type EasyPayDirectEnv = Pick<
  Env,
  | "EASY_PAY_DIRECT_COMMERCE_API_KEY"
  | "EASY_PAY_DIRECT_SECURITY_KEY"
  | "EASY_PAY_DIRECT_TOKENIZATION_KEY"
  | "EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET"
  | "EASY_PAY_DIRECT_NETWORK_MODE"
  | "EASY_PAY_DIRECT_LIVEMODE_ALLOWED"
  | "PUBLIC_BASE_URL"
>;

type CheckoutTokenPayload = { intent: string; expires: number };
type CommerceErrorBody = { error?: { code?: string; message?: string } };
export type CommerceCustomer = {
  id: string;
  email?: string | null;
  default_payment_method?: string | null;
};
export type CommercePaymentMethod = { id: string; customer?: string };
export type CommerceProduct = { id: string; pricing?: { amount?: number; currency?: string } };
export type CommerceOrder = {
  id: string;
  status:
    | "pending"
    | "succeeded"
    | "failed"
    | "voided"
    | "partially_refunded"
    | "refunded"
    | "refund_failed"
    | "chargeback"
    | "chargeback_accepted"
    | "chargeback_dismissed";
  total: number;
  currency: string;
  failure_reason?: string | null;
  transactions?: Array<{
    id?: string;
    type?: string;
    status?: string;
    processor_transaction_id?: string | null;
  }>;
};
export type GatewayVaultResult = { customerVaultId: string; billingId: string };

export async function createEasyPayDirectCheckoutUrl(
  env: EasyPayDirectEnv,
  input: { checkoutIntentId: string },
  now = Date.now(),
): Promise<{ paymentUrl: string; token: string; expiresAt: string }> {
  validateIdentifier(input.checkoutIntentId, "checkoutIntentId");
  assertEasyPayDirectNetwork(env);
  if (env.EASY_PAY_DIRECT_NETWORK_MODE === "production") {
    requiredSecret(env.EASY_PAY_DIRECT_TOKENIZATION_KEY, "EASY_PAY_DIRECT_TOKENIZATION_KEY");
  }
  const expires = Math.floor(now / 1000) + CHECKOUT_TTL_SECONDS;
  const token = await signCheckoutPayload(
    { intent: input.checkoutIntentId, expires },
    requiredSecret(
      env.EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET,
      "EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET",
    ),
  );
  const paymentUrl = new URL(
    "/easy_pay_direct/payment_form",
    requiredUrl(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL"),
  );
  paymentUrl.searchParams.set("checkout", token);
  return {
    paymentUrl: paymentUrl.toString(),
    token,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

export async function verifyEasyPayDirectCheckoutToken(
  value: string,
  signingSecret: string,
  now = Date.now(),
): Promise<CheckoutTokenPayload> {
  const [encodedPayload, providedSignature, extra] = value.split(".");
  if (!encodedPayload || !providedSignature || extra) {
    throw new ApiError(401, "easy_pay_direct_checkout_invalid", "Checkout link is invalid");
  }
  const expectedSignature = await hmacSha256Base64Url(signingSecret, encodedPayload);
  if (!(await constantTimeEqual(providedSignature, expectedSignature))) {
    throw new ApiError(401, "easy_pay_direct_checkout_invalid", "Checkout link is invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload)) as unknown;
  } catch {
    throw new ApiError(401, "easy_pay_direct_checkout_invalid", "Checkout link is invalid");
  }
  if (!isCheckoutTokenPayload(payload)) {
    throw new ApiError(401, "easy_pay_direct_checkout_invalid", "Checkout link is invalid");
  }
  if (payload.expires * 1000 <= now) {
    throw new ApiError(410, "easy_pay_direct_checkout_expired", "Checkout link has expired");
  }
  return payload;
}

export async function easyPayDirectPaymentForm(
  url: URL,
  env: EasyPayDirectEnv,
  now = Date.now(),
): Promise<Response> {
  const token = url.searchParams.get("checkout")?.trim();
  if (!token)
    throw new ApiError(400, "easy_pay_direct_checkout_required", "Checkout token is required");
  await verifyEasyPayDirectCheckoutToken(
    token,
    requiredSecret(
      env.EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET,
      "EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET",
    ),
    now,
  );
  assertEasyPayDirectNetwork(env);
  const isSandbox = env.EASY_PAY_DIRECT_NETWORK_MODE === "test";
  const collectScript = isSandbox
    ? ""
    : `<script src="${COLLECT_JS_URL}" data-tokenization-key="${escapeHtml(requiredSecret(env.EASY_PAY_DIRECT_TOKENIZATION_KEY, "EASY_PAY_DIRECT_TOKENIZATION_KEY"))}" data-variant="inline" data-field-ccnumber-selector="#ccnumber" data-field-ccexp-selector="#ccexp" data-field-cvv-selector="#cvv" data-field-cvv-display="required"></script>`;
  const paymentFields = isSandbox
    ? `<label>Sandbox outcome<select id="sandbox-token" class="input"><option value="card_visa">Approved Visa</option><option value="card_insufficient_funds">Insufficient funds</option><option value="card_visa_declined">Declined Visa</option></select></label>`
    : `<div class="fields"><div id="ccnumber" class="field"></div><div id="ccexp" class="field"></div><div id="cvv" class="field"></div></div>`;
  const submitScript = isSandbox
    ? `button.addEventListener('click',()=>submit(document.getElementById('sandbox-token').value));`
    : `CollectJS.configure({variant:'inline',paymentSelector:'#pay',callback:(response)=>submit(response.token)});`;
  const safeToken = escapeHtml(token);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure payment</title>` +
      `<style nonce="epd-style">body{font-family:ui-sans-serif,system-ui,sans-serif;background:#f7f7f8;color:#18181b;margin:0}.shell{max-width:520px;margin:48px auto;padding:0 20px}.card{background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:28px;box-shadow:0 12px 36px rgba(0,0,0,.08)}h1{font-size:24px;margin:0 0 8px}.note{color:#52525b;margin:0 0 24px}.fields{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px}.field,.input{box-sizing:border-box;width:100%;height:46px;border:1px solid #d4d4d8;border-radius:8px;padding:0 10px;margin:6px 0 16px}.error{min-height:22px;color:#b91c1c;margin:12px 0}button{width:100%;height:46px;border:0;border-radius:8px;background:#18181b;color:#fff;font-weight:700;cursor:pointer}button[disabled]{opacity:.55;cursor:wait}@media(max-width:520px){.fields{grid-template-columns:1fr}}</style>${collectScript}</head>` +
      `<body><main class="shell"><section class="card"><h1>${isSandbox ? "Sandbox payment" : "Secure payment"}</h1><p class="note">${isSandbox ? "No real money is moved. Choose a synthetic outcome." : "Card details are collected directly by Easy Pay Direct and never touch SERP servers."}</p>${paymentFields}<label>Phone number<input id="phone" class="input" inputmode="tel" autocomplete="tel" placeholder="+14155551234" required></label><p id="error" class="error" role="alert"></p><button id="pay" type="button">${isSandbox ? "Run sandbox payment" : "Pay securely"}</button></section></main>` +
      `<script nonce="epd-script">const checkout=${JSON.stringify(safeToken)};const button=document.getElementById('pay');const error=document.getElementById('error');async function submit(paymentToken){const phone=document.getElementById('phone').value.trim();if(!/^\\+[1-9]\\d{7,14}$/.test(phone)){error.textContent='Enter a phone number in international format, for example +14155551234';return}button.disabled=true;error.textContent='';try{const result=await fetch('/easy_pay_direct/payment_form',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({checkout,payment_token:paymentToken,phone})});const body=await result.json();if(!result.ok)throw new Error(body?.error?.message||body?.error||'Payment could not be processed');if(body.redirect_url){location.assign(body.redirect_url);return}button.textContent=body.status==='processing'?'Payment submitted':'Payment received'}catch(cause){error.textContent=cause instanceof Error?cause.message:'Payment could not be processed';button.disabled=false}}${submitScript}</script></body></html>`,
    { headers: checkoutHeaders(isSandbox) },
  );
}

export async function findEasyPayDirectCustomerByEmail(
  env: EasyPayDirectEnv,
  email: string,
  fetcher: typeof fetch = fetch,
): Promise<CommerceCustomer | null> {
  const result = await commerceRequest<{ data?: CommerceCustomer[] }>(
    env,
    `/customers?email=${encodeURIComponent(email)}&limit=1`,
    { method: "GET" },
    fetcher,
  );
  return result.data?.[0] ?? null;
}

export async function createEasyPayDirectCustomer(
  env: EasyPayDirectEnv,
  input: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    gatewayVaultId: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  },
  fetcher: typeof fetch = fetch,
): Promise<CommerceCustomer> {
  return commerceRequest<CommerceCustomer>(
    env,
    "/customers",
    {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        email: input.email,
        first_name: input.firstName,
        last_name: input.lastName,
        phone: input.phone,
        epd_gateway_customer_vault_id: input.gatewayVaultId,
        metadata: input.metadata,
      },
    },
    fetcher,
  );
}

export async function addEasyPayDirectPaymentMethod(
  env: EasyPayDirectEnv,
  input: { customerId: string; billingId: string; idempotencyKey: string },
  fetcher: typeof fetch = fetch,
): Promise<CommercePaymentMethod> {
  return commerceRequest<CommercePaymentMethod>(
    env,
    `/customers/${encodeURIComponent(input.customerId)}/payment_methods`,
    {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: { billing_id: input.billingId, set_as_default: true, update_subscriptions: false },
    },
    fetcher,
  );
}

export async function createEasyPayDirectProduct(
  env: EasyPayDirectEnv,
  input: {
    paymentRequestId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<CommerceProduct> {
  validateMoney(input.amountMinor, input.currency);
  const skuSuffix = (await sha256Hex(input.paymentRequestId)).slice(0, 24);
  return commerceRequest<CommerceProduct>(
    env,
    "/products",
    {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        name: `Lago payment request ${input.paymentRequestId}`.slice(0, 255),
        description: "SERP billing payment request",
        pricing: { amount: input.amountMinor, currency: input.currency.toLowerCase() },
        requires_shipping: false,
        sku: `lago_${skuSuffix}`,
        metadata: { lago_payment_request_id: input.paymentRequestId },
      },
    },
    fetcher,
  );
}

export async function createEasyPayDirectOrder(
  env: EasyPayDirectEnv,
  input: {
    customerId: string;
    paymentMethodId: string;
    productId: string;
    paymentRequestId: string;
    checkoutIntentId: string;
    currency: string;
    idempotencyKey: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<CommerceOrder> {
  return commerceRequest<CommerceOrder>(
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
        description: `Lago payment request ${input.paymentRequestId}`.slice(0, 255),
        metadata: {
          lago_payment_request_id: input.paymentRequestId,
          lago_checkout_intent_id: input.checkoutIntentId,
        },
      },
    },
    fetcher,
  );
}

export async function getEasyPayDirectOrder(
  env: EasyPayDirectEnv,
  orderId: string,
  fetcher: typeof fetch = fetch,
): Promise<CommerceOrder> {
  validateIdentifier(orderId, "orderId");
  return commerceRequest<CommerceOrder>(
    env,
    `/orders/${encodeURIComponent(orderId)}`,
    { method: "GET" },
    fetcher,
  );
}

export async function refundEasyPayDirectOrder(
  env: EasyPayDirectEnv,
  input: { orderId: string; amountMinor: number; currency: string; idempotencyKey?: string },
  fetcher: typeof fetch = fetch,
): Promise<{
  id: string | null;
  status: "succeeded" | "failed" | "unknown";
  responseText: string;
}> {
  validateIdentifier(input.orderId, "orderId");
  validateMoney(input.amountMinor, input.currency);
  const order = await commerceRequest<CommerceOrder>(
    env,
    `/orders/${encodeURIComponent(input.orderId)}/refund`,
    {
      method: "POST",
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      body: { amount: input.amountMinor },
    },
    fetcher,
  );
  const refund = [...(order.transactions ?? [])]
    .reverse()
    .find((tx) => tx.type?.toLowerCase().includes("refund"));
  return {
    id: refund?.processor_transaction_id ?? refund?.id ?? order.id,
    status:
      order.status === "refunded" || order.status === "partially_refunded"
        ? "succeeded"
        : order.status === "refund_failed"
          ? "failed"
          : "unknown",
    responseText: order.failure_reason?.trim() || order.status,
  };
}

export async function vaultEasyPayDirectCard(
  env: EasyPayDirectEnv,
  input: { paymentToken: string; existingCustomerVaultId?: string | null },
  fetcher: typeof fetch = fetch,
): Promise<GatewayVaultResult> {
  if (env.EASY_PAY_DIRECT_NETWORK_MODE !== "production") {
    throw new ApiError(
      422,
      "easy_pay_direct_gateway_not_required",
      "Gateway vaulting is only used for live payments",
    );
  }
  const securityKey = assertEasyPayDirectNetwork(env).gatewaySecurityKey;
  let customerVaultId = input.existingCustomerVaultId?.trim() || null;
  if (!customerVaultId) {
    customerVaultId = (
      await gatewayVaultRequest(
        new URLSearchParams({
          security_key: securityKey,
          payment_token: input.paymentToken,
          customer_vault: "add_customer",
        }),
        fetcher,
      )
    ).customerVaultId;
  }
  const addBilling = await gatewayVaultRequest(
    new URLSearchParams({
      security_key: securityKey,
      payment_token: input.paymentToken,
      customer_vault: "add_billing",
      customer_vault_id: customerVaultId,
    }),
    fetcher,
  );
  if (!addBilling.billingId) {
    throw new ApiError(
      503,
      "easy_pay_direct_gateway_vault_incomplete",
      "EPD Gateway did not return a billing ID",
    );
  }
  return { customerVaultId, billingId: addBilling.billingId };
}

export async function easyPayDirectPaymentTokenHash(value: string): Promise<string> {
  return sha256Hex(value);
}

async function commerceRequest<T>(
  env: EasyPayDirectEnv,
  path: string,
  options: { method: "GET" | "POST" | "PATCH"; body?: unknown; idempotencyKey?: string },
  fetcher: typeof fetch,
): Promise<T> {
  const { commerceApiKey } = assertEasyPayDirectNetwork(env);
  let response: Response;
  try {
    response = await fetcher(`${COMMERCE_API_URL}${path}`, {
      method: options.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${commerceApiKey}`,
        "EPD-Version": COMMERCE_API_VERSION,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.idempotencyKey ? { "X-EPD-Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(
      503,
      "easy_pay_direct_outcome_unknown",
      "Easy Pay Direct did not return an outcome",
    );
  }
  const raw = await readBoundedResponse(response, MAX_PROVIDER_RESPONSE_BYTES);
  let body: T | CommerceErrorBody;
  try {
    body = JSON.parse(raw) as T | CommerceErrorBody;
  } catch {
    throw new ApiError(
      503,
      "easy_pay_direct_invalid_response",
      "Easy Pay Direct returned an invalid response",
    );
  }
  if (!response.ok) {
    const error = (body as CommerceErrorBody).error;
    throw new ApiError(
      response.status === 429 ? 429 : response.status >= 500 ? 503 : response.status,
      error?.code?.trim() ||
        (response.status === 429 ? "easy_pay_direct_rate_limited" : "easy_pay_direct_error"),
      error?.message?.trim().slice(0, 500) || "Easy Pay Direct rejected the request",
    );
  }
  return body as T;
}

async function gatewayVaultRequest(
  body: URLSearchParams,
  fetcher: typeof fetch,
): Promise<{ customerVaultId: string; billingId: string | null }> {
  let response: Response;
  try {
    response = await fetcher(PAYMENT_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/x-www-form-urlencoded",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch {
    throw new ApiError(
      503,
      "easy_pay_direct_gateway_outcome_unknown",
      "EPD Gateway did not return a vault outcome",
    );
  }
  const raw = await readBoundedResponse(response, MAX_PROVIDER_RESPONSE_BYTES);
  const values = new URLSearchParams(raw);
  if (!response.ok || values.get("response") !== "1") {
    throw new ApiError(
      response.status === 429 ? 429 : 503,
      values.get("response_code")?.trim() || "easy_pay_direct_gateway_vault_failed",
      values.get("responsetext")?.trim().slice(0, 500) || "EPD Gateway could not vault the card",
    );
  }
  const customerVaultId = values.get("customer_vault_id")?.trim();
  if (!customerVaultId) {
    throw new ApiError(
      503,
      "easy_pay_direct_gateway_vault_incomplete",
      "EPD Gateway did not return a customer vault ID",
    );
  }
  return { customerVaultId, billingId: values.get("billing_id")?.trim() || null };
}

function assertEasyPayDirectNetwork(env: EasyPayDirectEnv): {
  commerceApiKey: string;
  gatewaySecurityKey: string;
} {
  const mode = env.EASY_PAY_DIRECT_NETWORK_MODE;
  if (mode !== "test" && mode !== "production") {
    throw new ApiError(
      503,
      "easy_pay_direct_network_disabled",
      "Easy Pay Direct network access is disabled",
    );
  }
  if (mode === "production" && env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "1") {
    throw new ApiError(
      503,
      "easy_pay_direct_livemode_forbidden",
      "Easy Pay Direct live mode is disabled",
    );
  }
  const commerceApiKey = requiredSecret(
    env.EASY_PAY_DIRECT_COMMERCE_API_KEY,
    "EASY_PAY_DIRECT_COMMERCE_API_KEY",
  );
  if (mode === "test" && !easyPayDirectKeyMatchesMode(commerceApiKey, "test")) {
    throw new ApiError(
      503,
      "easy_pay_direct_key_environment_mismatch",
      "Easy Pay Direct sandbox mode requires a sandbox API key",
    );
  }
  if (mode === "production" && !easyPayDirectKeyMatchesMode(commerceApiKey, "live")) {
    throw new ApiError(
      503,
      "easy_pay_direct_key_environment_mismatch",
      "Easy Pay Direct live mode requires a live API key",
    );
  }
  return {
    commerceApiKey,
    gatewaySecurityKey:
      mode === "production"
        ? requiredSecret(env.EASY_PAY_DIRECT_SECURITY_KEY, "EASY_PAY_DIRECT_SECURITY_KEY")
        : "",
  };
}

function easyPayDirectKeyMatchesMode(key: string, mode: "test" | "live"): boolean {
  const match = key.match(/^epd_[A-Za-z0-9]+_[A-Za-z0-9]+_(test|live)_[A-Za-z0-9]+$/u);
  return match?.[1] === mode;
}

function checkoutHeaders(isSandbox: boolean): HeadersInit {
  const gateway = "https://secure.easypaydirectgateway.com";
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": isSandbox
      ? "default-src 'none'; script-src 'nonce-epd-script'; style-src 'nonce-epd-style'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      : `default-src 'none'; script-src 'nonce-epd-script' ${gateway}; style-src 'nonce-epd-style'; frame-src ${gateway}; connect-src 'self' ${gateway}; img-src data: ${gateway}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function validateMoney(amountMinor: number, currency: string): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    throw new ApiError(422, "invalid_easy_pay_direct_amount", "Amount must be positive");
  if (!/^[A-Z]{3}$/.test(currency))
    throw new ApiError(
      422,
      "invalid_easy_pay_direct_currency",
      "Currency must be a three-letter code",
    );
}

function validateIdentifier(value: string, name: string): void {
  if (!value.trim() || value.length > 512)
    throw new ApiError(422, "invalid_easy_pay_direct_identifier", `${name} is invalid`);
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value?.trim())
    throw new ApiError(503, "provider_not_configured", `${name} is not configured`);
  return value.trim();
}

function requiredUrl(value: string | undefined, name: string): string {
  const candidate = requiredSecret(value, name);
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
      throw new Error("invalid_protocol");
    return url.toString();
  } catch {
    throw new ApiError(503, "provider_not_configured", `${name} must be a valid URL`);
  }
}

async function signCheckoutPayload(payload: CheckoutTokenPayload, secret: string): Promise<string> {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${await hmacSha256Base64Url(secret, encodedPayload)}`;
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return encodeBase64Url(String.fromCharCode(...new Uint8Array(signature)));
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftDigest, rightDigest);
}

function isCheckoutTokenPayload(value: unknown): value is CheckoutTokenPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.intent === "string" &&
    record.intent.length > 0 &&
    record.intent.length <= 512 &&
    Number.isSafeInteger(record.expires) &&
    Number(record.expires) > 0
  );
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new ApiError(
      503,
      "easy_pay_direct_response_too_large",
      "Easy Pay Direct response was too large",
    );
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ApiError(
        503,
        "easy_pay_direct_response_too_large",
        "Easy Pay Direct response was too large",
      );
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
