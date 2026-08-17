import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT || 4173);
const root = new URL("../operator-app/", import.meta.url).pathname;

const organizations = {
  "serp-billing": {
    id: "org-preview-primary",
    externalId: "serp-billing",
    name: "SERP Billing",
    slug: "serp-billing",
    role: "admin",
    currency: "USD",
    timezone: "Pacific/Fiji",
  },
  "serp-labs": {
    id: "org-preview-secondary",
    externalId: "serp-labs",
    name: "SERP Labs",
    slug: "serp-labs",
    role: "viewer",
    currency: "NZD",
    timezone: "Pacific/Auckland",
  },
};

const customers = {
  "serp-billing": [
    {
      lago_id: "customer-preview-tammy",
      external_id: "tammy",
      name: "Tammy Jones",
      email: "tammy@example.invalid",
      currency: "USD",
      timezone: "America/New_York",
      net_payment_term: 14,
      invoice_grace_period: 2,
      version: 1,
    },
    {
      lago_id: "customer-preview-henry",
      external_id: "henry_1234",
      name: "Henry Graham",
      email: "henry@example.invalid",
      currency: "USD",
      timezone: "Europe/London",
      net_payment_term: null,
      invoice_grace_period: 0,
      version: 1,
    },
  ],
  "serp-labs": [
    {
      lago_id: "customer-preview-labs",
      external_id: "labs-synthetic",
      name: "Labs Synthetic",
      email: "labs@example.invalid",
      currency: "NZD",
      timezone: "Pacific/Auckland",
      net_payment_term: 7,
      invoice_grace_period: 0,
      version: 1,
    },
  ],
};

const primaryPreviewCollections = {
  api_keys: [
    {
      id: "key-preview-primary",
      name: "Store checkout",
      value: "••••••••••••serp",
      created_at: "2026-08-12T08:00:00Z",
      last_used_at: "2026-08-18T01:20:00Z",
    },
  ],
  invoice_custom_sections: [
    {
      code: "payment-terms",
      name: "Payment terms",
      display_name: "Terms",
      description: "Synthetic preview section",
      details: "Net 14 days",
    },
  ],
  payment_receipts: [
    {
      lago_id: "receipt-preview-001",
      number: "RCP-2026-001",
      created_at: "2026-08-18T01:20:00Z",
      payment: {
        external_customer_id: "tammy",
        invoice_numbers: ["SERP-2026-001"],
        amount_cents: 4900,
        amount_currency: "USD",
        payment_status: "succeeded",
      },
    },
  ],
  taxes: [
    {
      code: "sales-tax",
      name: "Sales tax",
      rate: "7.5",
      description: "Synthetic manual tax",
      applied_to_organization: false,
    },
  ],
  add_ons: [
    {
      code: "priority-support",
      name: "Priority support",
      description: "Synthetic fixed-price support item",
      amount_cents: 1500,
      amount_currency: "USD",
      invoice_display_name: "Priority support",
    },
  ],
  coupons: [
    {
      code: "WELCOME20",
      name: "Welcome discount",
      description: "Synthetic onboarding discount",
      coupon_type: "percentage",
      percentage_rate: "20",
      frequency: "once",
      expiration: "no_expiration",
    },
  ],
  applied_coupons: [],
  plans: [
    {
      code: "creator-monthly",
      name: "Creator Monthly",
      description: "Synthetic recurring plan",
      interval: "monthly",
      amount_cents: 4900,
      amount_currency: "USD",
      trial_period: 7,
      fixed_charges: [],
    },
  ],
  subscriptions: [
    {
      lago_id: "subscription-preview-001",
      external_id: "tammy-creator-monthly",
      external_customer_id: "tammy",
      name: "Creator Monthly",
      plan_code: "creator-monthly",
      status: "active",
      billing_time: "anniversary",
      subscription_at: "2026-08-01T00:00:00Z",
      current_period_start: "2026-08-01T00:00:00Z",
      current_period_end: "2026-09-01T00:00:00Z",
    },
  ],
  invoices: [
    {
      lago_id: "invoice-preview-001",
      number: "SERP-2026-001",
      external_customer_id: "tammy",
      invoice_type: "subscription",
      status: "finalized",
      payment_status: "succeeded",
      total_amount_cents: 4900,
      currency: "USD",
      issuing_date: "2026-08-01",
      created_at: "2026-08-01T00:00:00Z",
    },
  ],
  wallets: [
    {
      lago_id: "wallet-preview-001",
      code: "tammy-granted-credit",
      name: "Launch credits",
      external_customer_id: "tammy",
      credits_balance: "20",
      balance_cents: 2000,
      currency: "USD",
      rate_amount: "1",
      status: "active",
      expiration_at: "2026-12-31T23:59:59Z",
    },
  ],
  credit_notes: [
    {
      lago_id: "credit-note-preview-001",
      number: "CN-2026-001",
      invoice_number: "SERP-2026-001",
      external_customer_id: "tammy",
      reason: "order_cancellation",
      status: "finalized",
      credit_status: "available",
      balance_amount_cents: 500,
      currency: "USD",
    },
  ],
  payments: [
    {
      lago_id: "payment-preview-001",
      type: "provider",
      external_customer_id: "tammy",
      invoice_numbers: ["SERP-2026-001"],
      payment_provider_code: "authorize_net",
      payment_status: "succeeded",
      amount_cents: 4900,
      amount_currency: "USD",
      created_at: "2026-08-18T01:20:00Z",
    },
  ],
  quotes: [
    {
      lago_id: "quote-preview-001",
      lago_customer_id: "customer-preview-tammy",
      external_customer_id: "tammy",
      number: "Q-2026-001",
      order_type: "subscription",
      updated_at: "2026-08-18T00:00:00Z",
      current_version: {
        lago_id: "quote-version-preview-001",
        version: 1,
        status: "draft",
        lock_version: 1,
        content: "Synthetic annual proposal",
        billing_items: [],
        updated_at: "2026-08-18T00:00:00Z",
      },
    },
  ],
  data_exports: [
    {
      lago_id: "export-preview-001",
      resource_type: "invoices",
      status: "completed",
      row_count: 1,
      byte_size: 384,
      created_at: "2026-08-18T00:00:00Z",
    },
  ],
  webhook_endpoints: [
    {
      lago_id: "webhook-preview-001",
      name: "SERP events",
      webhook_url: "https://example.invalid/lago-webhooks",
      signature_algo: "hmac_sha256",
      event_types: ["invoice.created", "payment.succeeded"],
      created_at: "2026-08-12T00:00:00Z",
    },
  ],
  dunning_campaigns: [
    {
      code: "standard-recovery",
      name: "Standard recovery",
      description: "Synthetic payment recovery policy",
      max_attempts: 3,
      days_between_attempts: 3,
      thresholds: [{ amount_cents: 1000, currency: "USD" }],
      applied_to_organization: true,
      customers_count: 2,
    },
  ],
  payment_requests: [],
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname.startsWith("/api/operator/v1/")) {
    respondJson(response, previewApi(url.pathname, request.headers["x-operator-organization"]));
    return;
  }

  const relativePath = url.pathname.startsWith("/assets/")
    ? url.pathname.slice(1)
    : url.pathname === "/_headers"
      ? "_headers"
      : "index.html";
  const filePath = normalize(join(root, relativePath));
  if (!filePath.startsWith(root)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`Lago operator preview listening on http://127.0.0.1:${port}\n`);
});

function previewApi(pathname, requestedSlug) {
  if (typeof requestedSlug === "string" && requestedSlug && !organizations[requestedSlug]) {
    return {
      __status: 403,
      error: {
        code: "operator_organization_forbidden",
        message: "This preview identity has no membership for the requested organization",
      },
    };
  }
  const slug =
    typeof requestedSlug === "string" && organizations[requestedSlug]
      ? requestedSlug
      : "serp-billing";
  const organization = organizations[slug];
  const memberships = Object.values(organizations).map((candidate) => ({
    membership_id: `membership-${candidate.slug}`,
    role: candidate.role,
    organization: {
      lago_id: candidate.id,
      external_id: candidate.externalId,
      name: candidate.name,
      slug: candidate.slug,
    },
  }));

  if (pathname === "/api/operator/v1/session") {
    return {
      operator: {
        membership_id: `membership-${slug}`,
        organization_id: organization.id,
        organization_external_id: organization.externalId,
        organization_name: organization.name,
        organization_slug: organization.slug,
        role: organization.role,
        memberships,
      },
    };
  }
  if (pathname === "/api/operator/v1/organization") {
    return {
      organization: {
        lago_id: organization.id,
        name: organization.name,
        slug: organization.slug,
        default_currency: organization.currency,
        timezone: organization.timezone,
        version: 1,
      },
    };
  }
  if (pathname === "/api/operator/v1/billing-entities/default") {
    return {
      billing_entity: {
        lago_id: organization.id,
        code: "default",
        name: organization.name,
        legal_name: organization.name,
        legal_number: "SYNTHETIC-PREVIEW",
        email: "billing@example.invalid",
        default_currency: organization.currency,
        timezone: organization.timezone,
        net_payment_term: 14,
        invoice_grace_period: 2,
        document_numbering: "per_billing_entity",
        document_number_prefix: "SERP",
        document_locale: "en",
        finalize_zero_amount_invoice: true,
        taxes_count: 0,
        invoice_custom_sections_count: 0,
        version: 1,
      },
    };
  }
  if (pathname === "/api/operator/v1/customers") {
    return { customers: customers[slug], meta: { total_count: customers[slug].length } };
  }

  const collections = {
    "/api/operator/v1/api-keys": "api_keys",
    "/api/operator/v1/invoice-custom-sections": "invoice_custom_sections",
    "/api/operator/v1/payment-receipts": "payment_receipts",
    "/api/operator/v1/taxes": "taxes",
    "/api/operator/v1/add-ons": "add_ons",
    "/api/operator/v1/coupons": "coupons",
    "/api/operator/v1/applied-coupons": "applied_coupons",
    "/api/operator/v1/plans": "plans",
    "/api/operator/v1/subscriptions": "subscriptions",
    "/api/operator/v1/invoices": "invoices",
    "/api/operator/v1/wallets": "wallets",
    "/api/operator/v1/credit-notes": "credit_notes",
    "/api/operator/v1/payments": "payments",
    "/api/operator/v1/quotes": "quotes",
    "/api/operator/v1/data-exports": "data_exports",
    "/api/operator/v1/webhook-endpoints": "webhook_endpoints",
    "/api/operator/v1/dunning-campaigns": "dunning_campaigns",
    "/api/operator/v1/payment-requests": "payment_requests",
  };
  const collection = collections[pathname];
  const items = slug === "serp-billing" ? (primaryPreviewCollections[collection] ?? []) : [];
  return collection ? { [collection]: items, meta: { total_count: items.length } } : {};
}

function respondJson(response, payload) {
  const status = Number(payload?.__status) || 200;
  if (payload && typeof payload === "object") delete payload.__status;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}
