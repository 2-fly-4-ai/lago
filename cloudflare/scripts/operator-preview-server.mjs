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
      applied_dunning_campaign_id: "campaign-preview-standard",
      exclude_from_dunning_campaign: false,
      selected_invoice_custom_sections: [],
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
      applied_dunning_campaign_id: null,
      exclude_from_dunning_campaign: false,
      selected_invoice_custom_sections: [],
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
      applied_dunning_campaign_id: null,
      exclude_from_dunning_campaign: false,
      selected_invoice_custom_sections: [],
      version: 1,
    },
  ],
};

const primaryPreviewCollections = {
  billable_metrics: [
    {
      lago_id: "metric-preview-api-calls",
      code: "api_calls",
      name: "API calls",
      description: "Counts each billable API request",
      aggregation_type: "count_agg",
      field_name: null,
      recurring: false,
      expression: null,
      created_at: "2026-07-12T00:00:00Z",
    },
    {
      lago_id: "metric-preview-storage",
      code: "storage_gb",
      name: "Storage",
      description: "Sums stored gigabytes",
      aggregation_type: "sum_agg",
      field_name: "gb",
      recurring: true,
      expression: null,
      created_at: "2026-07-14T00:00:00Z",
    },
  ],
  features: [
    {
      lago_id: "feature-preview-exports",
      code: "data_exports",
      name: "Data exports",
      description: "Controls data export availability and formats",
      subscriptions_count: 14,
      plans_count: 2,
      created_at: "2026-07-10T00:00:00Z",
      privileges: [
        {
          lago_id: "priv-preview-enabled",
          code: "enabled",
          name: "Enabled",
          value_type: "boolean",
          config: {},
        },
        {
          lago_id: "priv-preview-format",
          code: "format",
          name: "Format",
          value_type: "select",
          config: { select_options: ["csv", "json"] },
        },
      ],
    },
    {
      lago_id: "feature-preview-seats",
      code: "team_seats",
      name: "Team seats",
      description: "Controls the number of operator seats",
      subscriptions_count: 8,
      plans_count: 1,
      created_at: "2026-07-16T00:00:00Z",
      privileges: [
        {
          lago_id: "priv-preview-limit",
          code: "limit",
          name: "Seat limit",
          value_type: "integer",
          config: {},
        },
      ],
    },
  ],
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
  pricing_units: [
    {
      lago_id: "pricing-unit-preview-credits",
      code: "credits",
      name: "Credits",
      short_name: "cr",
      description: "Customer-visible usage credits",
      version: 1,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
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
      total_due_amount_cents: 0,
      total_paid_amount_cents: 4900,
      currency: "USD",
      issuing_date: "2026-08-01",
      created_at: "2026-08-01T00:00:00Z",
      fees: [
        {
          lago_id: "fee-preview-001",
          invoice_display_name: "Creator Monthly",
          description: "Creator Monthly",
          units: "1",
          amount_cents: 4900,
        },
      ],
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
      lago_id: "campaign-preview-standard",
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
    if (/\/ai\/conversations\/[^/]+\/messages$/.test(url.pathname)) {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
      });
      response.end(
        'data: {"response":"Your synthetic billing workspace has stable recurring revenue, two active usage metrics, and no overdue invoice warnings."}\n\ndata: [DONE]\n\n',
      );
      return;
    }
    if (/\/(?:invoices|credit-notes|payment-receipts)\/[^/]+\/download$/.test(url.pathname)) {
      response.writeHead(200, {
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="synthetic-document.pdf"',
        "Content-Type": "application/pdf",
      });
      response.end("%PDF-1.4\n% synthetic browser preview\n");
      return;
    }
    respondJson(
      response,
      previewApi(
        url.pathname,
        request.headers["x-operator-organization"],
        request.method,
        url.searchParams,
      ),
    );
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

function previewApi(pathname, requestedSlug, method = "GET", searchParams = new URLSearchParams()) {
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
        subscription_invoice_issuing_date_adjustment: "align_with_finalization_date",
        subscription_invoice_issuing_date_anchor: "next_period_start",
        finalize_zero_amount_invoice: true,
        taxes_count: 0,
        invoice_custom_sections_count: 0,
        version: 1,
      },
    };
  }
  if (pathname === "/api/operator/v1/billing-entities/default/taxes") {
    return { taxes: slug === "serp-billing" ? primaryPreviewCollections.taxes.slice(0, 1) : [] };
  }
  if (pathname === "/api/operator/v1/billing-entities/default/dunning-campaign") {
    return {
      dunning_campaign:
        method === "DELETE" || slug !== "serp-billing"
          ? null
          : primaryPreviewCollections.dunning_campaigns[0],
    };
  }
  if (pathname === "/api/operator/v1/billing-entities/default/logo") {
    return method === "DELETE"
      ? { logo: null }
      : { logo: { file_url: pathname, mime_type: "image/png", filename: "logo.png", version: 1 } };
  }
  if (pathname === "/api/operator/v1/customers") {
    return { customers: customers[slug], meta: { total_count: customers[slug].length } };
  }
  if (pathname === "/api/operator/v1/analytics") {
    return previewAnalytics(organization.currency);
  }
  if (pathname === "/api/operator/v1/forecasts") {
    return previewForecast(organization.currency);
  }
  if (pathname === "/api/operator/v1/ai/conversations") {
    return method === "POST"
      ? {
          conversation: {
            lago_id: "conversation-preview-new",
            title: "New conversation",
            status: "active",
            messages_count: 0,
            created_at: "2026-08-18T00:00:00Z",
            updated_at: "2026-08-18T00:00:00Z",
            messages: [],
          },
        }
      : { conversations: [] };
  }
  if (pathname === "/api/operator/v1/observability/activity-logs") {
    return {
      activity_logs: [
        {
          lago_id: "activity-preview-customer",
          event_type: "customer.updated",
          resource_type: "customer",
          resource_id: "customer-preview-tammy",
          version: 2,
          changes: { status: "active", email: "[redacted]" },
          occurred_at: "2026-08-18T01:24:00Z",
          delivery_status: "published",
        },
      ],
    };
  }
  if (pathname === "/api/operator/v1/observability/api-logs") {
    return {
      api_logs: [
        {
          lago_id: "api-log-preview-001",
          request_id: "request-preview-001",
          method: "GET",
          path: "/api/operator/v1/customers",
          status: 200,
          duration_ms: 12,
          occurred_at: "2026-08-18T01:25:00Z",
          request_body: "Not retained",
          response_body: "Not retained",
        },
      ],
    };
  }
  if (pathname === "/api/operator/v1/observability/events") {
    return {
      events: [
        {
          lago_id: "event-preview-001",
          transaction_id: "txn-preview-001",
          code: "video_download",
          external_subscription_id: "tammy-creator-monthly",
          timestamp: "2026-08-18T01:22:00Z",
          received_at: "2026-08-18T01:22:01Z",
          properties: "Redacted from operator logs",
        },
      ],
    };
  }
  if (pathname === "/api/operator/v1/team/members") {
    return {
      members: [
        {
          lago_id: "membership-preview-admin",
          identity: "Access identity …a1b2c3d4e5f6",
          role: "admin",
          status: "active",
          created_at: "2026-08-15T00:00:00Z",
        },
      ],
    };
  }
  if (pathname === "/api/operator/v1/team/invitations") {
    return {
      invitations:
        method === "POST"
          ? [
              {
                lago_id: "invitation-preview",
                identity: "Invited email …f6e5d4c3b2a1",
                role: "viewer",
                status: "pending",
                expires_at: "2026-08-25T00:00:00Z",
              },
            ]
          : [],
    };
  }
  if (pathname === "/api/operator/v1/team/roles") {
    return {
      roles: [
        {
          code: "admin",
          name: "Admin",
          description: "Manage billing configuration and operator memberships",
        },
        {
          code: "viewer",
          name: "Viewer",
          description: "Read tenant-scoped billing data and reports",
        },
      ],
    };
  }
  if (pathname === "/api/operator/v1/team/authentication") {
    return {
      authentication: {
        provider: "cloudflare_access",
        enforced: true,
        password_login: false,
        social_login: false,
        sso_configuration: "Managed by the Cloudflare Access application",
      },
    };
  }
  if (pathname === "/api/operator/v1/integrations") {
    const catalog = [
      ["stripe", "Stripe", "payments"],
      ["adyen", "Adyen", "payments"],
      ["authorize_net", "Authorize.Net", "payments"],
      ["cashfree", "Cashfree", "payments"],
      ["flutterwave", "Flutterwave", "payments"],
      ["gocardless", "GoCardless", "payments"],
      ["moneyhash", "MoneyHash", "payments"],
      ["anrok", "Anrok", "tax"],
      ["avalara", "Avalara", "tax"],
      ["lago_tax_management", "Lago tax management", "tax"],
      ["netsuite", "NetSuite", "accounting"],
      ["xero", "Xero", "accounting"],
      ["hubspot", "HubSpot", "crm"],
      ["salesforce", "Salesforce", "crm"],
    ];
    return {
      integrations: catalog.map(([provider_code, name, integration_group]) => ({
        provider_code,
        name,
        integration_group,
        display_name: null,
        status: "disabled",
        settings: {},
        secret_ready: false,
        external_actions_enabled: false,
      })),
    };
  }
  if (/^\/api\/operator\/v1\/customers\/[^/]+\/portal-token$/.test(pathname)) {
    return { portal_token: "a".repeat(64), shown_once: true };
  }
  const customerSettingsMatch = pathname.match(
    /^\/api\/operator\/v1\/customers\/([^/]+)\/document-settings$/,
  );
  if (customerSettingsMatch) {
    return {
      document_settings: {
        external_customer_id: customerSettingsMatch[1],
        document_locale: "en",
        subscription_invoice_issuing_date_adjustment: "keep_anchor",
        subscription_invoice_issuing_date_anchor: "current_period_end",
      },
    };
  }
  if (/^\/api\/operator\/v1\/customers\/[^/]+\/taxes(?:\/[^/]+)?$/.test(pathname)) {
    return { taxes: slug === "serp-billing" ? primaryPreviewCollections.taxes.slice(0, 1) : [] };
  }
  const invoiceMetadataMatch = pathname.match(/^\/api\/operator\/v1\/invoices\/([^/]+)\/metadata$/);
  if (invoiceMetadataMatch) {
    return {
      metadata: [{ lago_id: "metadata-preview-po", key: "purchase_order", value: "PO-2026-42" }],
    };
  }
  const progressiveMatch = pathname.match(
    /^\/api\/operator\/v1\/subscriptions\/([^/]+)\/progressive-billing$/,
  );
  if (progressiveMatch) {
    return {
      progressive_billing: {
        external_subscription_id: progressiveMatch[1],
        disabled: method === "PUT" ? true : false,
      },
    };
  }
  const invoiceAdjustedMatch = pathname.match(
    /^\/api\/operator\/v1\/invoices\/([^/]+)\/adjusted-fees(?:\/(preview))?$/,
  );
  if (invoiceAdjustedMatch) {
    return invoiceAdjustedMatch[2]
      ? {
          adjusted_fee: {
            invoice_line_id: "fee-preview-001",
            description: "Corrected creator fee",
            units: "1",
            unit_amount_cents: "4900",
            amount_cents: 4900,
          },
        }
      : { adjusted_fees: [] };
  }
  const invoicePaymentMatch = pathname.match(
    /^\/api\/operator\/v1\/invoices\/([^/]+)\/payment-status$/,
  );
  if (invoicePaymentMatch) {
    return { invoice: { lago_id: invoicePaymentMatch[1], payment_status: "succeeded" } };
  }
  const invoiceRegenerateMatch = pathname.match(
    /^\/api\/operator\/v1\/invoices\/([^/]+)\/regenerate$/,
  );
  if (invoiceRegenerateMatch) {
    return {
      invoice: {
        lago_id: "invoice-preview-regenerated",
        status: "draft",
        total_amount_cents: 4900,
      },
    };
  }
  const invoiceDetailMatch = pathname.match(/^\/api\/operator\/v1\/invoices\/([^/]+)$/);
  if (invoiceDetailMatch) {
    const invoice = primaryPreviewCollections.invoices.find(
      (item) => item.lago_id === invoiceDetailMatch[1],
    );
    return {
      invoice: invoice
        ? {
            ...invoice,
            fees: [
              {
                lago_id: "fee-preview-001",
                invoice_display_name: "Creator Monthly",
                description: "Creator Monthly",
                units: "1",
                amount_cents: 4900,
              },
            ],
          }
        : null,
    };
  }
  if (pathname === "/api/operator/v1/credit-notes/estimate") {
    return {
      credit_note: {
        currency: organization.currency,
        total_amount_cents: 1,
        sub_total_excluding_taxes_amount_cents: 1,
        coupons_adjustment_amount_cents: 0,
        taxes_amount_cents: 0,
        credit_amount_cents: 1,
        balance_amount_cents: 1,
      },
    };
  }
  const creditNoteDetailMatch = pathname.match(/^\/api\/operator\/v1\/credit-notes\/([^/]+)$/);
  if (creditNoteDetailMatch) {
    return {
      credit_note:
        primaryPreviewCollections.credit_notes.find(
          (item) => item.lago_id === creditNoteDetailMatch[1],
        ) ?? null,
    };
  }
  if (pathname === "/api/operator/v1/webhook-endpoints/webhook-preview-001/logs") {
    return {
      webhook_logs: [
        {
          lago_id: "webhook-log-preview-001",
          webhook_endpoint_id: "webhook-preview-001",
          event_id: "event-preview-invoice",
          event_type: "invoice.created",
          status: "succeeded",
          attempts: 1,
          http_status: 200,
          last_attempted_at: "2026-08-18T01:26:00Z",
          created_at: "2026-08-18T01:25:59Z",
          updated_at: "2026-08-18T01:26:00Z",
          payload: "Not retained in operator responses",
          response: "Not retained in operator responses",
          retry_available: false,
        },
      ],
    };
  }
  const activityMatch = pathname.match(
    /^\/api\/operator\/v1\/(features|billable-metrics)\/([^/]+)\/activity$/,
  );
  if (activityMatch) {
    return {
      activity_logs: [
        {
          lago_id: `activity-preview-${activityMatch[2]}`,
          event_type:
            activityMatch[1] === "features" ? "feature.created" : "billable_metric.created",
          version: 1,
          payload: { synthetic: true },
          occurred_at: "2026-07-10T00:00:00Z",
        },
      ],
    };
  }
  const planEntitlementsMatch = pathname.match(
    /^\/api\/operator\/v1\/plans\/([^/]+)\/entitlements$/,
  );
  if (planEntitlementsMatch) {
    return {
      plan_code: planEntitlementsMatch[1],
      entitlements:
        method === "PUT"
          ? []
          : [
              {
                lago_id: "entitlement-preview-exports",
                feature_id: "feature-preview-exports",
                feature_code: "data_exports",
                feature_name: "Data exports",
                privileges: [
                  {
                    privilege_id: "priv-preview-enabled",
                    privilege_code: "enabled",
                    privilege_name: "Enabled",
                    value_type: "boolean",
                    config: {},
                    value: true,
                  },
                  {
                    privilege_id: "priv-preview-format",
                    privilege_code: "format",
                    privilege_name: "Format",
                    value_type: "select",
                    config: { select_options: ["csv", "json"] },
                    value: "csv",
                  },
                ],
              },
            ],
    };
  }
  const featureMatch = pathname.match(/^\/api\/operator\/v1\/features\/([^/]+)$/);
  if (featureMatch) {
    return {
      feature:
        primaryPreviewCollections.features.find((feature) => feature.lago_id === featureMatch[1]) ??
        null,
    };
  }
  if (pathname === "/api/operator/v1/alerts") {
    const resourceType = searchParams.get("resource_type") ?? "subscription";
    return {
      alerts:
        slug === "serp-billing"
          ? [
              {
                lago_id: `alert-preview-${resourceType}`,
                resource_type: resourceType,
                resource_id: searchParams.get("resource_id") ?? "preview-resource",
                alert_type:
                  resourceType === "wallet"
                    ? "wallet_balance_amount"
                    : "billable_metric_current_usage_units",
                billable_metric_id: resourceType === "wallet" ? null : "metric-preview-api-calls",
                code: `${resourceType}-threshold`,
                name: `${resourceType === "wallet" ? "Wallet" : "Usage"} threshold`,
                thresholds: [{ value: "500", recurring: true }],
                version: 1,
              },
            ]
          : [],
    };
  }

  const collections = {
    "/api/operator/v1/api-keys": "api_keys",
    "/api/operator/v1/invoice-custom-sections": "invoice_custom_sections",
    "/api/operator/v1/pricing-units": "pricing_units",
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
    "/api/operator/v1/billable-metrics": "billable_metrics",
    "/api/operator/v1/features": "features",
  };
  const collection = collections[pathname];
  const items = slug === "serp-billing" ? (primaryPreviewCollections[collection] ?? []) : [];
  return collection ? { [collection]: items, meta: { total_count: items.length } } : {};
}

function previewAnalytics(currency) {
  const monthly = [
    ["2026-03", 18400],
    ["2026-04", 21700],
    ["2026-05", 24600],
    ["2026-06", 27400],
    ["2026-07", 30100],
    ["2026-08", 32800],
  ].map(([period, amount_minor]) => ({ period, amount_minor }));
  return {
    analytics: {
      currency,
      from: "2025-09-01",
      to: "2026-08-18",
      customer_external_id: null,
      revenue_streams: {
        total_amount_minor: monthly.reduce((total, point) => total + point.amount_minor, 0),
        monthly,
        breakdown: [
          { stream: "subscription", amount_minor: 139500, invoice_count: 31 },
          { stream: "one_off", amount_minor: 35500, invoice_count: 9 },
        ],
        plan_breakdown: [
          {
            code: "creator-monthly",
            name: "Creator Monthly",
            amount_minor: 139500,
            invoice_count: 31,
          },
          { code: "one_off", name: "One-off invoices", amount_minor: 35500, invoice_count: 9 },
        ],
        customer_breakdown: [
          { code: "tammy", name: "Tammy Jones", amount_minor: 109000, invoice_count: 24 },
          { code: "henry_1234", name: "Henry Graham", amount_minor: 66000, invoice_count: 16 },
        ],
      },
      mrr: {
        amount_minor: 32800,
        subscriptions_count: 14,
        plan_breakdown: [
          {
            code: "creator-monthly",
            name: "Creator Monthly",
            amount_minor: 32800,
            subscriptions_count: 14,
          },
        ],
      },
      usage: {
        total_amount_minor: 28400,
        total_units: "18420",
        total_events_count: 18420,
        daily: monthly.map((point) => ({
          ...point,
          amount_minor: Math.round(point.amount_minor * 0.18),
        })),
        billable_metrics: [
          { code: "api_calls", amount_minor: 18400, units: "17400", events_count: 17400 },
          { code: "storage_gb", amount_minor: 10000, units: "1020", events_count: 1020 },
        ],
      },
      prepaid_credits: {
        balance_minor: 2000,
        consumed_minor: 8500,
        wallets_count: 2,
        monthly: monthly.map((point, index) => ({
          period: point.period,
          granted_minor: index % 2 === 0 ? 2000 : 0,
          purchased_minor: 1000,
          consumed_minor: 1200 + index * 100,
        })),
      },
      invoices: {
        total_amount_minor: 175000,
        total_count: 40,
        breakdown: [
          {
            status: "finalized",
            payment_status: "succeeded",
            amount_minor: 162000,
            invoice_count: 35,
          },
          { status: "finalized", payment_status: "pending", amount_minor: 13000, invoice_count: 5 },
        ],
        collection_breakdown: [
          { status: "collected", amount_minor: 162000, invoice_count: 35 },
          { status: "outstanding", amount_minor: 9000, invoice_count: 3 },
          { status: "overdue", amount_minor: 4000, invoice_count: 2 },
        ],
      },
    },
  };
}

function previewForecast(currency) {
  const projected_months = ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"].map(
    (period, index) => {
      const realistic = 34000 + index * 2400;
      return {
        period,
        optimistic_amount_minor: Math.round(realistic * 1.14),
        realistic_amount_minor: realistic,
        conservative_amount_minor: Math.round(realistic * 0.87),
      };
    },
  );
  return {
    forecast: {
      currency,
      generated_at: "2026-08-18T00:00:00Z",
      historical_months: [],
      projected_months,
      methodology: "Trailing six-month invoiced revenue with bounded month-over-month trend",
    },
  };
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
