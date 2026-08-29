import { sha256Hex } from "../auth/api-key";
import { ApiError } from "../http";

const COMMERCE_API_URL = "https://api.epd.com/v1";
const COMMERCE_API_VERSION = "2026-02-11";
const PAYMENT_API_URL = "https://secure.easypaydirectgateway.com/api/transact.php";
const COLLECT_JS_URL = "https://secure.easypaydirectgateway.com/token/Collect.js";
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const CHECKOUT_TTL_SECONDS = 20 * 60;
const INTERNAL_CHECKOUT_COPY =
  /\b(?:synthetic|sandbox|internal qa|test fixture|product canary)\b|routed through lago/iu;

export type EasyPayDirectEnv = Pick<
  Env,
  | "EASY_PAY_DIRECT_COMMERCE_API_KEY"
  | "EASY_PAY_DIRECT_SECURITY_KEY"
  | "EASY_PAY_DIRECT_TOKENIZATION_KEY"
  | "EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET"
  | "EASY_PAY_DIRECT_NETWORK_MODE"
  | "EASY_PAY_DIRECT_LIVEMODE_ALLOWED"
  | "EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL"
  | "PUBLIC_BASE_URL"
>;

export type EasyPayDirectCheckoutEnv = EasyPayDirectEnv & Pick<Env, "BILLING_DB">;

export type EasyPayDirectCheckoutPresentation = {
  title: string;
  description: string | null;
  interval: string | null;
  amountMinor: number;
  subtotalMinor: number;
  taxMinor: number;
  creditsMinor: number;
  currency: string;
  customerEmail: string | null;
};

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
export type GatewayVaultFailureDetails = {
  provider: "easy_pay_direct_gateway";
  phase: "vault";
  definitive: boolean;
  providerResponseCode: string | null;
  providerResponseText: string;
  providerReferenceId: string | null;
};
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
  env: EasyPayDirectEnv & Partial<Pick<Env, "BILLING_DB">>,
  now = Date.now(),
  presentationOverride?: EasyPayDirectCheckoutPresentation,
): Promise<Response> {
  const token = url.searchParams.get("checkout")?.trim();
  if (!token)
    throw new ApiError(400, "easy_pay_direct_checkout_required", "Checkout token is required");
  const tokenPayload = await verifyEasyPayDirectCheckoutToken(
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
  const presentation =
    presentationOverride ??
    (env.BILLING_DB
      ? await loadEasyPayDirectCheckoutPresentation(
          env.BILLING_DB,
          tokenPayload.intent,
          await sha256Hex(token),
        )
      : null);
  if (!presentation) {
    throw new ApiError(401, "easy_pay_direct_checkout_invalid", "Checkout link is invalid");
  }
  const returnTo = resolveEasyPayDirectSuccessRedirect(
    url.searchParams.get("return_to"),
    env.EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL,
  );
  return renderEasyPayDirectPaymentForm(token, env, false, presentation, returnTo);
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
  return renderEasyPayDirectPaymentForm(token, env, true, null, null);
}

export function resolveEasyPayDirectSuccessRedirect(
  requested: string | null | undefined,
  configured: string | null | undefined,
): string | null {
  const configuredValue = configured?.trim();
  if (!configuredValue) return null;
  let allowed: URL;
  try {
    allowed = new URL(configuredValue);
  } catch {
    throw new ApiError(
      503,
      "easy_pay_direct_redirect_not_configured",
      "Easy Pay Direct success redirect is invalid",
    );
  }
  if (allowed.protocol !== "https:" || allowed.username || allowed.password) {
    throw new ApiError(
      503,
      "easy_pay_direct_redirect_not_configured",
      "Easy Pay Direct success redirect is invalid",
    );
  }
  const requestedValue = requested?.trim();
  if (!requestedValue) return allowed.toString();
  let candidate: URL;
  try {
    candidate = new URL(requestedValue);
  } catch {
    throw new ApiError(
      422,
      "easy_pay_direct_redirect_invalid",
      "Checkout success redirect is invalid",
    );
  }
  if (
    candidate.protocol !== allowed.protocol ||
    candidate.origin !== allowed.origin ||
    candidate.pathname !== allowed.pathname ||
    candidate.username ||
    candidate.password ||
    candidate.hash
  ) {
    throw new ApiError(
      422,
      "easy_pay_direct_redirect_invalid",
      "Checkout success redirect is invalid",
    );
  }
  return candidate.toString();
}

async function loadEasyPayDirectCheckoutPresentation(
  database: D1Database,
  intentId: string,
  tokenHash: string,
): Promise<EasyPayDirectCheckoutPresentation | null> {
  const row = await database
    .prepare(
      `SELECT intent.amount_minor, intent.currency, customer.email AS customer_email,
            COALESCE(
              (SELECT COALESCE(plan.invoice_display_name, plan.name)
               FROM invoices_payment_requests link
               JOIN invoice_subscriptions invoice_subscription
                 ON invoice_subscription.invoice_id = link.invoice_id
               JOIN subscriptions subscription ON subscription.id = invoice_subscription.subscription_id
               JOIN plans plan ON plan.id = subscription.plan_id
               WHERE link.payment_request_id = intent.payment_request_id
               ORDER BY invoice_subscription.created_at DESC LIMIT 1),
              (SELECT line.description
               FROM invoices_payment_requests link
               JOIN invoice_lines line ON line.invoice_id = link.invoice_id
               WHERE link.payment_request_id = intent.payment_request_id
               ORDER BY ABS(line.amount_minor) DESC, line.created_at ASC LIMIT 1),
              'SERP subscription'
            ) AS title,
            (SELECT plan.description
             FROM invoices_payment_requests link
             JOIN invoice_subscriptions invoice_subscription
               ON invoice_subscription.invoice_id = link.invoice_id
             JOIN subscriptions subscription ON subscription.id = invoice_subscription.subscription_id
             JOIN plans plan ON plan.id = subscription.plan_id
             WHERE link.payment_request_id = intent.payment_request_id
             ORDER BY invoice_subscription.created_at DESC LIMIT 1) AS description,
            (SELECT plan.interval
             FROM invoices_payment_requests link
             JOIN invoice_subscriptions invoice_subscription
               ON invoice_subscription.invoice_id = link.invoice_id
             JOIN subscriptions subscription ON subscription.id = invoice_subscription.subscription_id
             JOIN plans plan ON plan.id = subscription.plan_id
             WHERE link.payment_request_id = intent.payment_request_id
             ORDER BY invoice_subscription.created_at DESC LIMIT 1) AS interval,
            COALESCE((SELECT SUM(invoice.subtotal_minor)
              FROM invoices_payment_requests link
              JOIN invoices invoice ON invoice.id = link.invoice_id
              WHERE link.payment_request_id = intent.payment_request_id), intent.amount_minor) AS subtotal_minor,
            COALESCE((SELECT SUM(invoice.tax_minor)
              FROM invoices_payment_requests link
              JOIN invoices invoice ON invoice.id = link.invoice_id
              WHERE link.payment_request_id = intent.payment_request_id), 0) AS tax_minor,
            COALESCE((SELECT SUM(invoice.credits_minor)
              FROM invoices_payment_requests link
              JOIN invoices invoice ON invoice.id = link.invoice_id
              WHERE link.payment_request_id = intent.payment_request_id), 0) AS credits_minor
       FROM payment_request_checkout_intents intent
       JOIN customers customer
         ON customer.id = intent.customer_id AND customer.organization_id = intent.organization_id
       WHERE intent.id = ? AND intent.provider = 'easy_pay_direct'
         AND intent.provider_token_sha256 = ? AND intent.status = 'succeeded' LIMIT 1`,
    )
    .bind(intentId, tokenHash)
    .first<{
      amount_minor: number;
      currency: string;
      customer_email: string | null;
      title: string;
      description: string | null;
      interval: string | null;
      subtotal_minor: number;
      tax_minor: number;
      credits_minor: number;
    }>();
  if (!row) return null;
  return {
    title: row.title,
    description: row.description,
    interval: row.interval,
    amountMinor: row.amount_minor,
    subtotalMinor: row.subtotal_minor,
    taxMinor: row.tax_minor,
    creditsMinor: row.credits_minor,
    currency: row.currency,
    customerEmail: row.customer_email,
  };
}

function renderEasyPayDirectPaymentForm(
  token: string,
  env: EasyPayDirectEnv,
  synthetic: boolean,
  presentation: EasyPayDirectCheckoutPresentation | null,
  returnTo: string | null,
): Response {
  const isTest = env.EASY_PAY_DIRECT_NETWORK_MODE !== "production";
  const collectScript = synthetic
    ? ""
    : `<script src="${COLLECT_JS_URL}" data-tokenization-key="${escapeHtml(requiredSecret(env.EASY_PAY_DIRECT_TOKENIZATION_KEY, "EASY_PAY_DIRECT_TOKENIZATION_KEY"))}"></script>`;
  const paymentFields = synthetic
    ? `<label class="field-label" for="sandbox-token">Sandbox outcome</label><select id="sandbox-token" class="input"><option value="card_visa">Approved Visa</option><option value="card_insufficient_funds">Insufficient funds</option><option value="card_visa_declined">Declined Visa</option></select>`
    : `<fieldset class="payment-fields"><legend>Payment method</legend><div class="method-card"><div class="method-name"><span class="method-radio" aria-hidden="true"></span><strong>Card</strong><span class="provider-note">Secured by Easy Pay Direct</span></div><div class="field-grid"><div class="field-group field-wide"><div class="label-row"><span id="ccnumber-label" class="field-label">Card number</span>${isTest ? '<span class="test-chip">TEST</span>' : ""}</div><div id="ccnumber" class="hosted-field" role="group" aria-labelledby="ccnumber-label"></div></div><div class="field-group"><span id="ccexp-label" class="field-label">Expiration</span><div id="ccexp" class="hosted-field" role="group" aria-labelledby="ccexp-label"></div></div><div class="field-group"><span id="cvv-label" class="field-label">Security code</span><div id="cvv" class="hosted-field" role="group" aria-labelledby="cvv-label"></div></div></div></div></fieldset>`;
  const submitScript = synthetic
    ? `button.addEventListener('click',()=>submit(document.getElementById('sandbox-token').value));`
    : `CollectJS.configure({variant:'inline',paymentSelector:'#pay',styleSniffer:false,customCss:{color:'#172033','background-color':'#ffffff','font-family':'ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif','font-size':'16px','font-weight':'500','line-height':'24px',padding:'13px 14px','border-style':'none','border-width':'0'},placeholderCss:{color:'#8a94a6'},focusCss:{color:'#172033','background-color':'#ffffff'},invalidCss:{color:'#b42318'},validCss:{color:'#172033'},fields:{ccnumber:{selector:'#ccnumber',title:'Card number',placeholder:'1234 1234 1234 1234',enableCardBrandPreviews:true},ccexp:{selector:'#ccexp',title:'Expiration date',placeholder:'MM / YY'},cvv:{display:'required',selector:'#cvv',title:'Security code',placeholder:'CVV'}},validationCallback:(field,valid,message)=>{const id={ccnum:'ccnumber',ccnumber:'ccnumber',ccexp:'ccexp',cvv:'cvv'}[field];const container=id&&document.getElementById(id);if(container){container.classList.toggle('is-invalid',!valid);container.setAttribute('aria-invalid',String(!valid))}if(!valid&&message)error.textContent=message;else if(valid)error.textContent=''},timeoutDuration:10000,timeoutCallback:()=>{error.textContent='The secure card fields did not respond. Check the details and try again.';button.disabled=false},fieldsAvailableCallback:()=>{button.disabled=false;document.getElementById('payment-status').textContent='Secure fields ready'},callback:(response)=>submit(response.token)});`;
  const submissionPath = synthetic
    ? "/easy_pay_direct/sandbox_tool"
    : "/easy_pay_direct/payment_form";
  const title = escapeHtml(
    presentation
      ? (customerFacingCheckoutCopy(presentation.title) ?? "SERP App Plan")
      : "Synthetic sandbox QA",
  );
  const customerDescription = presentation
    ? customerFacingCheckoutCopy(presentation.description)
    : null;
  const description = customerDescription
    ? `<p class="product-description">${escapeHtml(customerDescription)}</p>`
    : "";
  const interval = intervalLabel(presentation?.interval ?? null);
  const purchaseVerb = interval ? "Subscribe to" : "Buy";
  const livePaymentLabel = interval ? "Subscribe" : "Pay now";
  const amount = presentation
    ? formatCheckoutMoney(presentation.amountMinor, presentation.currency)
    : "Internal QA";
  const subtotal = presentation
    ? formatCheckoutMoney(presentation.subtotalMinor, presentation.currency)
    : "—";
  const taxRow =
    presentation && presentation.taxMinor > 0
      ? `<div class="total-row"><span>Tax</span><strong>${formatCheckoutMoney(presentation.taxMinor, presentation.currency)}</strong></div>`
      : "";
  const creditRow =
    presentation && presentation.creditsMinor > 0
      ? `<div class="total-row discount"><span>Discounts &amp; credits</span><strong>−${formatCheckoutMoney(presentation.creditsMinor, presentation.currency)}</strong></div>`
      : "";
  const summary = presentation
    ? `<section class="summary-panel"><div class="summary-inner"><a class="back-link" href="javascript:history.back()" aria-label="Go back">← <img class="brand-mark" src="https://apps.serp.co/logo.svg" alt="SERP"></a><p class="summary-kicker">${purchaseVerb} ${title}</p><div class="price"><span>${amount}</span>${interval ? `<small>per<br>${escapeHtml(interval)}</small>` : ""}</div><div class="product-line"><div><strong>${title}</strong>${description}<span class="billing-note">${interval ? `Billed ${escapeHtml(presentation.interval ?? "")}` : "One-time payment"}</span></div><strong>${subtotal}</strong></div><div class="totals"><div class="total-row"><span>Subtotal</span><strong>${subtotal}</strong></div>${creditRow}${taxRow}<div class="total-row due"><span>Total due today</span><strong>${amount}</strong></div></div></div></section>`
    : `<section class="summary-panel"><div class="summary-inner"><span class="brand">SERP</span><p class="summary-kicker">Internal payment testing</p><div class="price"><span>QA</span></div><div class="route-note"><strong>Synthetic outcomes only</strong><span>No provider card form is used on this internal surface.</span></div></div></section>`;
  const contact = presentation
    ? `<section class="form-section"><h2>Contact</h2><label class="field-label" for="email">Email</label><input id="email" class="input" type="email"${presentation.customerEmail ? ` value="${escapeHtml(presentation.customerEmail)}" readonly aria-readonly="true"` : ' placeholder="you@example.com" autocomplete="email" required maxlength="254"'}><p class="field-help">${presentation.customerEmail ? "This email is locked to the signed checkout." : "Your receipt and product access will be linked to this email."}</p></section>`
    : "";
  const terms = presentation
    ? `<label class="terms"><input id="terms" type="checkbox" required><span>I agree to SERP's <a href="https://apps.serp.co/legal/terms" target="_blank" rel="noreferrer">Terms of Service</a> and <a href="https://apps.serp.co/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</span></label>`
    : "";
  const modeBanner = isTest
    ? `<div class="test-banner"><strong>EPD TEST MODE</strong><span>Test cards only. No real money will move.</span></div>`
    : "";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure payment</title>` +
      `<style nonce="epd-style">:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1d2433;background:#fff}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#fff}.checkout{display:grid;grid-template-columns:minmax(0,1fr) minmax(500px,1fr);min-height:100vh}.summary-panel{background:#f8f9fb;border-right:1px solid #e5e7eb}.summary-inner{width:min(100%,560px);margin-left:auto;padding:58px 72px 64px}.back-link{display:inline-flex;align-items:center;gap:12px;margin-bottom:64px;color:#667085;text-decoration:none}.brand,.brand-mark{color:#111827}.brand{font-size:15px;font-weight:900;letter-spacing:.14em}.brand-mark{display:block;width:24px;height:24px;object-fit:contain}.summary-kicker{margin:0 0 5px;color:#697386;font-size:18px}.price{display:flex;align-items:center;gap:12px;margin-bottom:68px;color:#161b26}.price>span{font-size:44px;font-weight:650;letter-spacing:-.04em}.price small{color:#697386;font-size:14px;font-weight:650;line-height:1.2}.product-line{display:flex;justify-content:space-between;gap:32px;padding-bottom:25px;border-bottom:1px solid #dfe3e8}.product-line>div{display:grid;gap:5px}.product-line strong{font-size:14px}.product-description,.billing-note{margin:0;color:#697386;font-size:13px;line-height:1.45}.totals{display:grid;gap:20px;padding-top:24px}.total-row{display:flex;justify-content:space-between;gap:24px;color:#2d3441;font-size:14px}.discount{color:#475467}.due{margin-top:4px;padding-top:22px;border-top:1px solid #dfe3e8;font-size:16px}.route-note{display:grid;gap:7px;margin-top:54px;padding:18px;border:1px solid #dfe3e8;border-radius:10px;background:#fff;color:#667085;font-size:12px;line-height:1.5}.route-note strong{color:#344054}.payment-panel{background:#fff}.payment-inner{width:min(100%,610px);padding:76px 72px 48px}.test-banner{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px;padding:11px 13px;border:1px solid #f4c66e;border-radius:8px;background:#fff9ed;color:#7a4605;font-size:12px}.test-banner strong{letter-spacing:.06em}.form-section{margin-bottom:34px}.form-section h2,.payment-fields legend{margin:0 0 15px;padding:0;color:#1d2433;font-size:15px;font-weight:750}.field-label,.label-row{display:block;color:#344054;font-size:13px;font-weight:700}.label-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}.field-group>.field-label{margin-bottom:7px}.field-help{margin:7px 0 0;color:#7a8495;font-size:11px}.test-chip{color:#8a4b08;font-size:10px;letter-spacing:.08em}.payment-fields{min-width:0;margin:0 0 22px;padding:0;border:0}.method-card{overflow:hidden;border:1px solid #d7dde5;border-radius:10px}.method-name{display:flex;align-items:center;gap:10px;padding:17px;border-bottom:1px solid #e5e7eb}.method-radio{width:15px;height:15px;border:4px solid #1473e6;border-radius:50%}.provider-note{margin-left:auto;color:#7a8495;font-size:11px}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px 12px;padding:18px}.field-wide{grid-column:1/-1}.hosted-field,.input{width:100%;height:50px;border:1px solid #cfd7e3;border-radius:7px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.04);transition:border-color .16s,box-shadow .16s}.hosted-field{overflow:hidden}.hosted-field iframe{display:block!important;width:100%!important;height:50px!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important}.hosted-field:focus-within,.input:focus{border-color:#1473e6;box-shadow:0 0 0 3px rgba(20,115,230,.12);outline:0}.hosted-field.is-invalid{border-color:#d92d20}.input{margin-top:7px;padding:0 14px;color:#172033;font:500 15px inherit}.input[readonly]{background:#f9fafb;color:#475467}.phone-label{display:block;margin-bottom:18px;color:#344054;font-size:13px;font-weight:700}.terms{display:flex;align-items:flex-start;gap:10px;margin:10px 0 18px;color:#667085;font-size:12px;line-height:1.5}.terms input{width:18px;height:18px;margin:0;accent-color:#1473e6}.terms a{color:#475467}.error{min-height:21px;margin:8px 0;color:#b42318;font-size:13px}.pay-button{display:flex;align-items:center;justify-content:center;width:100%;height:54px;border:0;border-radius:7px;background:#1473e6;color:#fff;font-size:15px;font-weight:750;cursor:pointer}.pay-button:hover{background:#0e66cf}.pay-button[disabled]{opacity:.5;cursor:wait}.trust-row{margin:16px 0 0;color:#667085;font-size:11px;text-align:center}.footer{display:flex;justify-content:center;gap:18px;margin-top:30px;color:#7a8495;font-size:11px}.footer a{color:inherit;text-decoration:none}.status{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:900px){.checkout{grid-template-columns:1fr}.summary-panel{border-right:0;border-bottom:1px solid #e5e7eb}.summary-inner,.payment-inner{width:100%;margin:0;padding:34px 24px}.back-link{margin-bottom:38px}.price{margin-bottom:42px}.payment-inner{max-width:640px;margin:auto}}@media(max-width:520px){.field-grid{grid-template-columns:1fr}.field-wide{grid-column:auto}.provider-note{display:none}.price>span{font-size:36px}}</style>${collectScript}</head>` +
      `<body><main class="checkout">${summary}<section class="payment-panel"><div class="payment-inner">${modeBanner}${contact}${paymentFields}<label class="phone-label">Phone number<input id="phone" class="input" inputmode="tel" autocomplete="tel" placeholder="+1 415 555 1234" required></label>${terms}<p id="error" class="error" role="alert"></p><span id="payment-status" class="status" role="status">${synthetic ? "Synthetic payment ready" : "Loading secure fields"}</span><button id="pay" class="pay-button" type="button"${synthetic ? "" : " disabled"}>${synthetic ? "Run synthetic QA payment" : isTest ? "Pay with EPD test mode" : livePaymentLabel}</button><p class="trust-row">Card details are securely tokenized by Easy Pay Direct</p><footer class="footer"><a href="https://apps.serp.co/legal/terms" target="_blank" rel="noreferrer">Legal</a><a href="https://apps.serp.co/privacy" target="_blank" rel="noreferrer">Privacy</a><span>Powered by Easy Pay Direct</span></footer></div></section></main>` +
      `<script nonce="epd-script">const checkout=${JSON.stringify(token)};const returnTo=${JSON.stringify(returnTo)};const button=document.getElementById('pay');const error=document.getElementById('error');async function submit(paymentToken){const phone=document.getElementById('phone').value.trim();const emailInput=document.getElementById('email');const email=emailInput?emailInput.value.trim():'';const terms=document.getElementById('terms');if(emailInput&&!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)){error.textContent='Enter a valid email address';emailInput.focus();return}if(!/^\\+[1-9]\\d{7,14}$/.test(phone)){error.textContent='Enter a phone number in international format, for example +14155551234';return}if(terms&&!terms.checked){error.textContent='Accept the Terms of Service and Privacy Policy to continue';terms.focus();return}button.disabled=true;error.textContent='';try{const result=await fetch(${JSON.stringify(submissionPath)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({checkout,payment_token:paymentToken,phone,...(emailInput?{email}:{}),terms_accepted:terms?terms.checked:true,...(returnTo?{return_to:returnTo}:{})})});const body=await result.json();if(!result.ok)throw new Error(body?.error?.message||body?.error||'Payment could not be processed');if(body.redirect_url){location.assign(body.redirect_url);return}button.textContent=body.status==='processing'?'Payment submitted':'Payment received'}catch(cause){error.textContent=cause instanceof Error?cause.message:'Payment could not be processed';button.disabled=false}}${submitScript}</script></body></html>`,
    { headers: checkoutHeaders(!synthetic) },
  );
}

function formatCheckoutMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountMinor / 100);
}

function intervalLabel(interval: string | null): string | null {
  if (!interval || interval === "one_time") return null;
  return (
    ({ weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" } as const)[
      interval as "weekly" | "monthly" | "quarterly" | "yearly"
    ] ?? interval
  );
}

function customerFacingCheckoutCopy(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && !INTERNAL_CHECKOUT_COPY.test(normalized) ? normalized : null;
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
  input: {
    paymentToken: string;
    billingId: string;
    existingCustomerVaultId?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<GatewayVaultResult> {
  if (env.EASY_PAY_DIRECT_NETWORK_MODE !== "production") {
    throw new ApiError(
      422,
      "easy_pay_direct_gateway_not_required",
      "Gateway vaulting is only used for live payments",
    );
  }
  validateIdentifier(input.billingId, "billingId");
  // NMI/EPD billing identifiers are limited to 32 characters. Lago's
  // idempotency keys are UUIDs (36 characters), so derive a stable,
  // collision-resistant gateway identifier instead of sending the UUID.
  const gatewayBillingId = (await sha256Hex(input.billingId)).slice(0, 32);
  const securityKey = assertEasyPayDirectNetwork(env).gatewaySecurityKey;
  const existingCustomerVaultId = input.existingCustomerVaultId?.trim() || null;
  const vault = await gatewayVaultRequest(
    new URLSearchParams({
      security_key: securityKey,
      payment_token: input.paymentToken,
      customer_vault: existingCustomerVaultId ? "add_billing" : "add_customer",
      ...(existingCustomerVaultId ? { customer_vault_id: existingCustomerVaultId } : {}),
      billing_id: gatewayBillingId,
    }),
    fetcher,
  );
  return {
    customerVaultId: existingCustomerVaultId ?? vault.customerVaultId,
    billingId: vault.billingId ?? gatewayBillingId,
  };
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
    const rawStatus = values.get("response")?.trim() || null;
    const providerResponseText =
      values.get("responsetext")?.trim().slice(0, 500) || "EPD Gateway could not vault the card";
    const details: GatewayVaultFailureDetails = {
      provider: "easy_pay_direct_gateway",
      phase: "vault",
      definitive: response.ok && (rawStatus === "2" || rawStatus === "3"),
      providerResponseCode: values.get("response_code")?.trim() || null,
      providerResponseText,
      providerReferenceId: values.get("refid")?.trim() || values.get("ref_id")?.trim() || null,
    };
    throw new ApiError(
      response.status === 429 ? 429 : details.definitive ? 422 : 503,
      details.providerResponseCode || "easy_pay_direct_gateway_vault_failed",
      details.definitive
        ? "Payment details could not be saved. No charge was made. Please start a new checkout and try again."
        : "The payment provider is temporarily unavailable. No charge was made.",
      details,
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
  const applePaySdk = "https://applepay.cdn-apple.com";
  const applePayInlineStyle = "'sha256-JobNDYsreMTIYfohuh2+pVhf0IMdNEBKOfHVBDG8q0g='";
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": usesGateway
      ? `default-src 'none'; script-src 'nonce-epd-script' ${gateway} ${applePaySdk}; style-src 'nonce-epd-style' ${applePayInlineStyle} ${gateway}; font-src ${applePaySdk}; frame-src ${gateway}; connect-src 'self' ${gateway}; img-src data: ${gateway} https://apps.serp.co; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
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
