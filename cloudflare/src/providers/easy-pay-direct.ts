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
export type GatewayTransactionResult = {
  id: string | null;
  status: "succeeded" | "failed" | "unknown";
  responseCode: string | null;
  responseText: string;
  authCode: string | null;
  orderId: string | null;
  customerVaultId: string | null;
  rawStatus: string | null;
};

export async function createEasyPayDirectCheckoutUrl(
  env: EasyPayDirectEnv,
  input: { checkoutIntentId: string },
  now = Date.now(),
): Promise<{ paymentUrl: string; token: string; expiresAt: string }> {
  validateIdentifier(input.checkoutIntentId, "checkoutIntentId");
  assertEasyPayDirectNetwork(env);
  if (
    env.EASY_PAY_DIRECT_NETWORK_MODE === "gateway_test" ||
    env.EASY_PAY_DIRECT_NETWORK_MODE === "production"
  ) {
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
  if (env.EASY_PAY_DIRECT_NETWORK_MODE === "test") {
    throw new ApiError(
      503,
      "easy_pay_direct_gateway_test_not_configured",
      "The product checkout requires Easy Pay Direct Gateway test mode",
    );
  }
  return renderEasyPayDirectPaymentForm(token, env, false);
}

export async function easyPayDirectSandboxTool(
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
  if (env.EASY_PAY_DIRECT_NETWORK_MODE === "production") {
    throw new ApiError(
      404,
      "easy_pay_direct_sandbox_tool_unavailable",
      "The Easy Pay Direct sandbox tool is unavailable",
    );
  }
  return renderEasyPayDirectPaymentForm(token, env, true);
}

function renderEasyPayDirectPaymentForm(
  token: string,
  env: EasyPayDirectEnv,
  synthetic: boolean,
): Response {
  const collectScript = synthetic
    ? ""
    : `<script src="${COLLECT_JS_URL}" data-tokenization-key="${escapeHtml(requiredSecret(env.EASY_PAY_DIRECT_TOKENIZATION_KEY, "EASY_PAY_DIRECT_TOKENIZATION_KEY"))}"></script>`;
  const paymentFields = synthetic
    ? `<label>Sandbox outcome<select id="sandbox-token" class="input"><option value="card_visa">Approved Visa</option><option value="card_insufficient_funds">Insufficient funds</option><option value="card_visa_declined">Declined Visa</option></select></label>`
    : `<fieldset class="payment-fields"><legend>Card details</legend><div class="field-grid"><div class="field-group field-wide"><div class="label-row"><span id="ccnumber-label" class="field-label">Card number</span><span class="test-chip">TEST</span></div><div id="ccnumber" class="hosted-field" role="group" aria-labelledby="ccnumber-label"></div></div><div class="field-group"><span id="ccexp-label" class="field-label">Expiration</span><div id="ccexp" class="hosted-field" role="group" aria-labelledby="ccexp-label"></div></div><div class="field-group"><span id="cvv-label" class="field-label">Security code</span><div id="cvv" class="hosted-field" role="group" aria-labelledby="cvv-label"></div></div></div></fieldset>`;
  const submitScript = synthetic
    ? `button.addEventListener('click',()=>submit(document.getElementById('sandbox-token').value));`
    : `CollectJS.configure({variant:'inline',paymentSelector:'#pay',styleSniffer:false,customCss:{color:'#172033','background-color':'#ffffff','font-family':'ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif','font-size':'16px','font-weight':'500','line-height':'24px',padding:'13px 14px','border-style':'none','border-width':'0'},placeholderCss:{color:'#8a94a6'},focusCss:{color:'#172033','background-color':'#ffffff'},invalidCss:{color:'#b42318'},validCss:{color:'#172033'},fields:{ccnumber:{selector:'#ccnumber',title:'Card number',placeholder:'1234 1234 1234 1234',enableCardBrandPreviews:true},ccexp:{selector:'#ccexp',title:'Expiration date',placeholder:'MM / YY'},cvv:{display:'required',selector:'#cvv',title:'Security code',placeholder:'CVV'}},validationCallback:(field,valid,message)=>{const id={ccnum:'ccnumber',ccnumber:'ccnumber',ccexp:'ccexp',cvv:'cvv'}[field];const container=id&&document.getElementById(id);if(container){container.classList.toggle('is-invalid',!valid);container.setAttribute('aria-invalid',String(!valid))}if(!valid&&message)error.textContent=message;else if(valid)error.textContent=''},timeoutDuration:10000,timeoutCallback:()=>{error.textContent='The secure card fields did not respond. Check the details and try again.';button.disabled=false},fieldsAvailableCallback:()=>{button.disabled=false;document.getElementById('payment-status').textContent='Secure fields ready'},callback:(response)=>submit(response.token)});`;
  const safeToken = escapeHtml(token);
  const submissionPath = synthetic
    ? "/easy_pay_direct/sandbox_tool"
    : "/easy_pay_direct/payment_form";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure payment</title>` +
      `<style nonce="epd-style">:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f2f5f9;color:#172033}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -20%,#e4ecfb 0,#f2f5f9 40%,#f7f8fa 100%)}.shell{width:min(100%,620px);margin:0 auto;padding:56px 20px}.card{overflow:hidden;background:#fff;border:1px solid #dbe2ea;border-radius:20px;box-shadow:0 24px 60px rgba(26,39,64,.12)}.card-head{padding:30px 32px 24px;border-bottom:1px solid #edf0f4}.eyebrow{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.secure-mark{display:inline-flex;align-items:center;gap:8px;color:#344054;font-size:13px;font-weight:700}.secure-mark svg{width:18px;height:18px;color:#17745b}.mode-badge{display:inline-flex;align-items:center;border:1px solid #f5c97b;border-radius:999px;background:#fff7e8;color:#8a4b08;padding:5px 10px;font-size:11px;font-weight:800;letter-spacing:.08em}.card-body{padding:28px 32px 32px}h1{font-size:28px;line-height:1.2;letter-spacing:-.025em;margin:0 0 8px}.note{color:#667085;line-height:1.55;margin:0}.payment-fields{min-width:0;margin:0 0 22px;padding:0;border:0}.payment-fields legend{margin:0 0 16px;padding:0;color:#344054;font-size:14px;font-weight:750}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px 12px}.field-wide{grid-column:1/-1}.field-label,.label-row{display:block;color:#344054;font-size:13px;font-weight:700}.label-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}.field-group>.field-label{margin-bottom:7px}.test-chip{color:#8a4b08;font-size:10px;letter-spacing:.08em}.hosted-field,.input{box-sizing:border-box;width:100%;height:52px;border:1px solid #cfd7e3;border-radius:10px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.04);transition:border-color .16s,box-shadow .16s}.hosted-field{overflow:hidden;padding:0}.hosted-field iframe{display:block!important;width:100%!important;height:52px!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important}.hosted-field:focus-within,.input:focus{border-color:#2970ff;box-shadow:0 0 0 4px rgba(41,112,255,.12);outline:0}.hosted-field.is-invalid{border-color:#d92d20;box-shadow:0 0 0 4px rgba(217,45,32,.1)}.input{margin-top:7px;padding:0 14px;color:#172033;font-family:inherit;font-size:16px;font-weight:500}.input::placeholder{color:#98a2b3}.phone-label{display:block;color:#344054;font-size:13px;font-weight:700}.error{min-height:21px;margin:9px 0;color:#b42318;font-size:13px}.pay-button{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;height:52px;border:0;border-radius:10px;background:#172033;color:#fff;font-size:15px;font-weight:750;cursor:pointer;box-shadow:0 8px 20px rgba(23,32,51,.18);transition:transform .15s,background .15s}.pay-button:hover{background:#26334b}.pay-button:active{transform:translateY(1px)}.pay-button svg{width:17px;height:17px}.pay-button[disabled]{opacity:.5;cursor:wait;box-shadow:none}.trust-row{display:flex;align-items:center;justify-content:center;gap:7px;margin:18px 0 0;color:#667085;font-size:12px;text-align:center}.trust-row svg{flex:none;width:15px;height:15px;color:#17745b}.status{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:560px){.shell{padding:20px 12px}.card{border-radius:16px}.card-head,.card-body{padding-left:20px;padding-right:20px}.field-grid{grid-template-columns:1fr}.field-wide{grid-column:auto}h1{font-size:25px}}</style>${collectScript}</head>` +
      `<body><main class="shell"><section class="card"><header class="card-head"><div class="eyebrow"><span class="secure-mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3m-9 0h8a2 2 0 0 1 2 2v7H6v-7a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Secure checkout</span><span class="mode-badge">TEST MODE</span></div><h1>${synthetic ? "Synthetic sandbox QA" : "Complete your test payment"}</h1><p class="note">${synthetic ? "Internal QA only. Choose a synthetic EPD Commerce outcome." : "Easy Pay Direct sandbox · Test cards only · No real money will move"}</p></header><div class="card-body">${paymentFields}<label class="phone-label">Phone number<input id="phone" class="input" inputmode="tel" autocomplete="tel" placeholder="+1 415 555 1234" required></label><p id="error" class="error" role="alert"></p><span id="payment-status" class="status" role="status">${synthetic ? "Synthetic payment ready" : "Loading secure fields"}</span><button id="pay" class="pay-button" type="button"${synthetic ? "" : " disabled"}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3m-9 0h8a2 2 0 0 1 2 2v7H6v-7a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>${synthetic ? "Run synthetic QA payment" : "Pay securely in test mode"}</button><p class="trust-row"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 12 3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 22c5-2.25 8-6 8-11V5l-8-3-8 3v6c0 5 3 8.75 8 11Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Card details are securely tokenized by Easy Pay Direct</p></div></section></main>` +
      `<script nonce="epd-script">const checkout=${JSON.stringify(safeToken)};const button=document.getElementById('pay');const error=document.getElementById('error');async function submit(paymentToken){const phone=document.getElementById('phone').value.trim();if(!/^\\+[1-9]\\d{7,14}$/.test(phone)){error.textContent='Enter a phone number in international format, for example +14155551234';return}button.disabled=true;error.textContent='';try{const result=await fetch(${JSON.stringify(submissionPath)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({checkout,payment_token:paymentToken,phone})});const body=await result.json();if(!result.ok)throw new Error(body?.error?.message||body?.error||'Payment could not be processed');if(body.redirect_url){location.assign(body.redirect_url);return}button.textContent=body.status==='processing'?'Payment submitted':'Payment received'}catch(cause){error.textContent=cause instanceof Error?cause.message:'Payment could not be processed';button.disabled=false}}${submitScript}</script></body></html>`,
    { headers: checkoutHeaders(!synthetic) },
  );
}

export async function chargeEasyPayDirectGatewayTestToken(
  env: EasyPayDirectEnv,
  input: {
    paymentToken: string;
    amountMinor: number;
    currency: string;
    orderId: string;
    orderDescription: string;
    customerEmail: string;
    firstName: string;
    lastName: string;
    phone: string;
    idempotencyKey: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<GatewayTransactionResult> {
  if (
    env.EASY_PAY_DIRECT_NETWORK_MODE !== "gateway_test" ||
    env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "0"
  ) {
    throw new ApiError(
      503,
      "easy_pay_direct_gateway_test_forbidden",
      "Easy Pay Direct Gateway test transactions are disabled",
    );
  }
  validateIdentifier(input.paymentToken, "paymentToken");
  validateIdentifier(input.orderId, "orderId");
  validateIdentifier(input.idempotencyKey, "idempotencyKey");
  validateMoney(input.amountMinor, input.currency);
  const body = new URLSearchParams({
    type: "sale",
    security_key: requiredSecret(env.EASY_PAY_DIRECT_SECURITY_KEY, "EASY_PAY_DIRECT_SECURITY_KEY"),
    payment_token: input.paymentToken,
    amount: (input.amountMinor / 100).toFixed(2),
    currency: input.currency,
    orderid: input.orderId.slice(0, 255),
    order_description: input.orderDescription.slice(0, 255),
    first_name: input.firstName.slice(0, 255),
    last_name: input.lastName.slice(0, 255),
    email: input.customerEmail.slice(0, 255),
    phone: input.phone.slice(0, 255),
    test_mode: "enabled",
    dup_seconds: "1200",
    customer_vault: "add_customer",
    initiated_by: "customer",
    stored_credential_indicator: "stored",
    merchant_defined_field_1: `lago_idempotency_key=${input.idempotencyKey}`,
  });
  return gatewayTransactionRequest(body, fetcher);
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

async function gatewayTransactionRequest(
  body: URLSearchParams,
  fetcher: typeof fetch,
): Promise<GatewayTransactionResult> {
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
      "EPD Gateway did not return a transaction outcome",
    );
  }
  const raw = await readBoundedResponse(response, MAX_PROVIDER_RESPONSE_BYTES);
  const values = new URLSearchParams(raw);
  const rawStatus = values.get("response")?.trim() || null;
  const responseText = values.get("responsetext")?.trim() || "Unknown provider response";
  const status =
    rawStatus === "1" ? "succeeded" : rawStatus === "2" || rawStatus === "3" ? "failed" : "unknown";
  if (!response.ok && status === "unknown") {
    throw new ApiError(
      response.status === 429 ? 429 : 503,
      response.status === 429 ? "easy_pay_direct_rate_limited" : "easy_pay_direct_gateway_error",
      responseText,
    );
  }
  return {
    id: values.get("transactionid")?.trim() || null,
    status,
    responseCode: values.get("response_code")?.trim() || null,
    responseText,
    authCode: values.get("authcode")?.trim() || null,
    orderId: values.get("orderid")?.trim() || null,
    customerVaultId: values.get("customer_vault_id")?.trim() || null,
    rawStatus,
  };
}

function assertEasyPayDirectNetwork(env: EasyPayDirectEnv): {
  commerceApiKey: string;
  gatewaySecurityKey: string;
} {
  const mode = env.EASY_PAY_DIRECT_NETWORK_MODE;
  if (mode !== "test" && mode !== "gateway_test" && mode !== "production") {
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
  if (mode === "gateway_test" && env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "0") {
    throw new ApiError(
      503,
      "easy_pay_direct_gateway_test_requires_livemode_disabled",
      "Easy Pay Direct Gateway test mode requires live mode to remain disabled",
    );
  }
  const commerceApiKey = requiredSecret(
    env.EASY_PAY_DIRECT_COMMERCE_API_KEY,
    "EASY_PAY_DIRECT_COMMERCE_API_KEY",
  );
  if (
    (mode === "test" || mode === "gateway_test") &&
    !easyPayDirectKeyMatchesMode(commerceApiKey, "test")
  ) {
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
      mode === "production" || mode === "gateway_test"
        ? requiredSecret(env.EASY_PAY_DIRECT_SECURITY_KEY, "EASY_PAY_DIRECT_SECURITY_KEY")
        : "",
  };
}

function easyPayDirectKeyMatchesMode(key: string, mode: "test" | "live"): boolean {
  const match = key.match(/^epd_[A-Za-z0-9]+_[A-Za-z0-9]+_(test|live)_[A-Za-z0-9]+$/u);
  return match?.[1] === mode;
}

function checkoutHeaders(usesGateway: boolean): HeadersInit {
  const gateway = "https://secure.easypaydirectgateway.com";
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": usesGateway
      ? `default-src 'none'; script-src 'nonce-epd-script' ${gateway}; style-src 'nonce-epd-style'; frame-src ${gateway}; connect-src 'self' ${gateway}; img-src data: ${gateway}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      : "default-src 'none'; script-src 'nonce-epd-script'; style-src 'nonce-epd-style'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
