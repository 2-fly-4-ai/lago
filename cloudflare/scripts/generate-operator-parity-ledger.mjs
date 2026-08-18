import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, "../..");
const inventoryPath = resolve(
  repositoryDirectory,
  "docs/reference/cloudflare-rewrite-feature-inventory.json",
);
const jsonOutputPath = resolve(
  repositoryDirectory,
  "docs/reference/cloudflare-operator-parity-ledger.json",
);
const markdownOutputPath = resolve(
  repositoryDirectory,
  "docs/reference/cloudflare-operator-parity-ledger.md",
);
const checkOnly = process.argv.includes("--check");

const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const originalOperations = inventory.operatorSurface.operations;
const originalRoutes = inventory.operatorSurface.routes;
const restReplacements = inventory.operatorSurface.restReplacements;

const surfaces = [
  {
    id: "ai-assistant",
    name: "Right-side AI assistant",
    sourcePatterns: [/\/aiAgent\//i],
    operationNamePatterns: [/aiAgent/i],
    routePatterns: [],
    implementationStatus: "complete",
    contract: "D1 conversation history plus a tenant-scoped streaming Worker AI contract",
    notes:
      "Global 48px rail, Lago-width panel, shortcuts, membership-scoped history, and Workers AI streaming are implemented.",
    evidence:
      "cloudflare/src/operator/ai.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts",
  },
  {
    id: "analytics",
    name: "Analytics",
    sourcePatterns: [/\/analytics\//i, /\/graphs\//i, /\/dashboards\//i],
    operationNamePatterns: [
      /GrossRevenues/i,
      /projectedUsage/i,
      /usageForSubscription/i,
      /SubscriptionUsage/i,
    ],
    routePatterns: [/ANALYTICS/i, /DASHBOARD/i],
    implementationStatus: "complete",
    contract: "Tenant-scoped D1 usage, invoice, revenue, MRR, and prepaid-credit read models",
    notes:
      "Five original tabs, customer and plan breakdowns, collection/overdue views, customer scope, and metric drill-down are executable. The former Superset embed is a native D1 dashboard and issues no external guest token.",
    evidence:
      "cloudflare/src/operator/analytics.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts",
  },
  {
    id: "forecasts",
    name: "Forecasts",
    sourcePatterns: [/\/forecasts\//i],
    operationNamePatterns: [/forecast/i],
    routePatterns: [/FORECAST/i],
    implementationStatus: "complete",
    contract: "Tenant-scoped forecast projection and bounded read contract",
    notes:
      "The original overview is implemented with bounded 3/6/12-month optimistic, realistic, and conservative projections.",
    evidence:
      "cloudflare/src/operator/analytics.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts",
  },
  {
    id: "billable-metrics",
    name: "Billable metrics",
    sourcePatterns: [/billableMetrics/i, /useCreateEditBillableMetric/i],
    operationNamePatterns: [/BillableMetric/i],
    routePatterns: [/BILLABLE_METRIC/i],
    implementationStatus: "complete",
    contract: "Existing canonical billable-metric API exposed through the Access BFF",
    notes:
      "List, detail, create, edit, delete, duplicate, expression/filter fields, and outbox-backed activity are exposed through Access.",
    evidence:
      "cloudflare/src/api/metered-usage.ts; cloudflare/src/operator/product-parity.ts; cloudflare/operator-app",
  },
  {
    id: "features-entitlements",
    name: "Features and entitlements",
    sourcePatterns: [/\/features\//i, /FeatureEntitlement/i, /featureEntitlement/i],
    operationNamePatterns: [/Entitlement/i],
    routePatterns: [/FEATURE/i],
    implementationStatus: "complete",
    contract:
      "Lago-owned D1 feature/privilege catalog with an explicit future serp-auth sync boundary",
    notes:
      "Lago owns feature and typed privilege CRUD plus plan entitlement values in D1; serp-auth remains an explicit future projection consumer.",
    evidence:
      "migration 0073; cloudflare/src/operator/features.ts; cloudflare/src/operator/product-parity.ts; operator-parity-surfaces.test.ts",
  },
  {
    id: "developer-observability",
    name: "Activity, API, event, and webhook logs",
    sourcePatterns: [/activityLogs/i, /apiLogs/i, /WebhookLog/i, /EventDetails/i],
    operationNamePatterns: [/^events?$/i, /eventTypes/i, /WebhookLog/i, /activityLog/i, /apiLog/i],
    routePatterns: [/ACTIVITY/i, /API_LOG/i, /WEBHOOK_LOG/i, /EVENT/i],
    implementationStatus: "complete",
    contract: "Redacted tenant-scoped event and request projections with bounded retention",
    notes:
      "Activity, API, usage-event, and webhook delivery list/detail reads are tenant scoped. Bodies and sensitive fields are not retained in operator responses; API metadata expires after 30 days. Webhook retry stays disabled under the user's explicit external-action safety boundary.",
    evidence:
      "migration 0074; cloudflare/src/operator/observability.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts",
  },
  {
    id: "customer-portal",
    name: "Customer portal",
    sourcePatterns: [/customerPortal/i],
    operationNamePatterns: [/CustomerPortal/i],
    routePatterns: [/CUSTOMER_PORTAL/i],
    implementationStatus: "complete",
    contract: "Separate public-token Worker contract and customer-safe projections",
    notes:
      "A separate Static Assets Worker authenticates opaque one-time customer tokens, exposes customer-safe invoice, wallet, usage, subscription, overdue, profile-update, and R2 PDF contracts, and never shares the operator Access boundary. Paid wallet top-up remains disabled under the user's external-action safety instruction.",
    evidence:
      "migration 0077; cloudflare/src/portal/index.ts; cloudflare/src/operator/portal-admin.ts; cloudflare/portal-app; portal.test.ts; portal-app-assets.test.ts",
  },
  {
    id: "identity-team",
    name: "Identity, invitations, team, roles, and authentication settings",
    sourcePatterns: [/\/auth\//i, /Invitation/i, /teamAndSecurity/i, /UserIdentifier/i],
    operationNamePatterns: [/CurrentUser/i, /MembersForFilter/i, /RolesList/i, /Invitation/i],
    routePatterns: [/AUTH/i, /INVIT/i, /MEMBER/i, /ROLE/i, /TEAM/i, /SIGN/i, /LOGIN/i, /PASSWORD/i],
    implementationStatus: "complete",
    contract: "Cloudflare Access authentication plus D1 organization memberships and role policy",
    notes:
      "Cloudflare Access replaces password, social, and Okta login routes. Hashed invitations are claimed on first Access login; tenant-scoped member and invitation role/revocation controls, fixed admin/viewer policy, last-admin protection, authentication settings, and security logs are executable.",
    evidence:
      "migration 0075; cloudflare/src/operator/access.ts; cloudflare/src/operator/team.ts; cloudflare/operator-app; operator-access.test.ts; operator-parity-surfaces.test.ts",
  },
  {
    id: "integrations",
    name: "Provider, accounting, CRM, tax, and payment integrations",
    sourcePatterns: [/\/integrations\//i, /Integration/i, /paymentMethodsList/i],
    operationNamePatterns: [
      /Integration/i,
      /PaymentProvider/i,
      /ExternalAppsAccordion/i,
      /TaxProvider/i,
      /syncHubspot/i,
      /syncSalesforce/i,
    ],
    routePatterns: [/INTEGRATION/i, /PAYMENT_PROVIDER/i, /PAYMENT_METHOD/i],
    implementationStatus: "complete",
    contract: "Provider-specific secret-safe Worker adapters behind disabled-by-default gates",
    notes:
      "All original payment, tax, accounting, and CRM provider families are present in a tenant-scoped registry and Lago settings UI. Non-secret preparation settings are editable; credential-shaped fields are rejected from D1. Provider calls, syncs, retries, payments, and tax actions remain disabled under the user's explicit external-action safety instruction.",
    evidence:
      "migration 0076; cloudflare/src/operator/integrations.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts",
  },
  {
    id: "core-operator",
    name: "Core billing and configuration operator",
    sourcePatterns: [/.*/],
    operationNamePatterns: [/.*/],
    routePatterns: [/.*/],
    implementationStatus: "partial",
    contract: `${restReplacements.length} tested Access-scoped REST replacement families`,
    notes:
      "The current pages cover bounded subsets. Exact original fields, tabs, filters, logs, advanced actions, and failure states still require operation-level verification.",
  },
];

const coreSafetyDisabledPatterns = [
  /^CreatePayment$/i,
  /^createPaymentRequest$/i,
  /^generate(?:Checkout|Payment)Url$/i,
  /^resend.*Email$/i,
  /^retry(?:AllInvoicePayments|Invoice|InvoicePayment|TaxReporting)$/i,
  /^fetchDraftInvoiceTaxes$/i,
  /^(?:createWebhookEndpoint|deleteWebhook|updateWebhookEndpoint)$/i,
  /^download(?:CreditNote|Invoice|PaymentReceipt)Xml$/i,
  /^disputeInvoice$/i,
];

const coreOperationContracts = [
  {
    family: "organization",
    patterns: [
      /^SideNavInfos$/i,
      /^getOrganization/i,
      /^GetOrganization/i,
      /^updateOrganizationSlug$/i,
    ],
  },
  {
    family: "billing-entity",
    patterns: [/^(?:get|Get|create|update).*BillingEntit/i, /^updateDocumentLocaleBillingEntity$/i],
    exclude: [/^(?:apply|remove)BillingEntity/i, /^updateBillingEntityLogo$/i],
  },
  {
    family: "api-keys",
    patterns: [/ApiKey/i, /OrganizationHmacData/i],
  },
  {
    family: "invoice-custom-sections",
    patterns: [/InvoiceCustomSection/i, /^(?:create|delete|update).*CustomSection$/i],
    exclude: [/^(?:apply|remove)BillingEntity/i, /^editCustomerInvoiceCustomSection$/i],
  },
  {
    family: "payment-receipts",
    patterns: [/PaymentReceipt/i],
    exclude: [/^(?:download|resend)/i],
  },
  {
    family: "taxes",
    patterns: [/Tax/i],
    exclude: [
      /CustomerAppliedTax/i,
      /AppliedTaxRateOnCustomer/i,
      /BillingEntityTaxes/i,
      /TaxProvider/i,
      /TaxReporting/i,
      /InvoiceTaxes/i,
    ],
  },
  {
    family: "add-ons",
    patterns: [/AddOn/i, /Addon/i],
  },
  {
    family: "coupons",
    patterns: [/Coupon/i],
  },
  {
    family: "customers",
    patterns: [/Customer/i],
    exclude: [
      /^deleteCustomer$/i,
      /^updateCustomer(?:DocumentLocale|FinalizeZeroAmountInvoice|IssuingDatePolicy)/i,
      /^editCustomer(?:DunningCampaign|InvoiceCustomSection)$/i,
      /CustomerAppliedTax/i,
      /AppliedTaxRateOnCustomer/i,
    ],
  },
  {
    family: "pricing-units-alerts",
    patterns: [/PricingUnit/i, /Alert/i],
    evidence:
      "migration 0078; cloudflare/src/operator/configuration.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts",
  },
  {
    family: "plans",
    patterns: [/Plan/i, /^plans$/i],
  },
  {
    family: "subscriptions",
    patterns: [/Subscription/i, /Subscribtion/i, /Subscribtions/i, /ProgressiveBilling/i],
    exclude: [/Alert/i, /Entitlement/i],
  },
  {
    family: "advanced-billing-configuration",
    patterns: [
      /^(?:apply|remove)BillingEntity(?:DunningCampaign|Taxes)$/i,
      /^updateBillingEntityLogo$/i,
      /CustomerAppliedTax/i,
      /AppliedTaxRateOnCustomer/i,
      /^deleteCustomer$/i,
      /^updateCustomer(?:DocumentLocale|IssuingDatePolicy)$/i,
      /AdjustedFee/i,
      /^download(?:CreditNote|Invoice|PaymentReceipt)/i,
      /^EditCreditNote$/i,
      /^creditNoteEstimate$/i,
      /InvoiceMetadata/i,
      /^regenerateInvoice$/i,
      /^updateInvoicePaymentStatus$/i,
    ],
    evidence:
      "migration 0079; cloudflare/src/operator/advanced-billing.ts; cloudflare/src/operator/index.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts",
  },
  {
    family: "invoices",
    patterns: [/Invoice/i],
    exclude: [
      /AdjustedFee/i,
      /^disputeInvoice$/i,
      /^downloadInvoice/i,
      /InvoiceMetadata/i,
      /^regenerateInvoice$/i,
      /^retry/i,
      /^resend/i,
      /^updateInvoicePaymentStatus$/i,
      /InvoiceTaxes/i,
    ],
  },
  {
    family: "wallets",
    patterns: [/Wallet/i],
    exclude: [/Alert/i],
  },
  {
    family: "credit-notes",
    patterns: [/CreditNote/i],
    exclude: [/^EditCreditNote$/i, /^creditNoteEstimate$/i, /^download/i, /^resend/i],
  },
  {
    family: "payments",
    patterns: [
      /^GetPaymentDetails$/i,
      /^getPaymentsList$/i,
      /^getRequestOverduePaymentInfos$/i,
      /PayableInvoice/i,
    ],
  },
  {
    family: "data-exports",
    patterns: [/DataExport/i],
  },
  {
    family: "webhook-endpoints",
    patterns: [/Webhook/i],
    exclude: [/^(?:create|delete|update)/i],
  },
  {
    family: "dunning-campaigns",
    patterns: [/DunningCampaign/i, /SingleCampaign/i],
    exclude: [/^(?:apply|editCustomer|remove)BillingEntityDunningCampaign$/i],
  },
  {
    family: "payment-requests",
    patterns: [/RequestOverduePayment/i],
  },
];

const coreEvidence =
  "cloudflare/src/operator/index.ts; cloudflare/src/api; cloudflare/operator-app; operator-access.test.ts";

function coreOperationContract(operation) {
  if (operation.name === "createBillingEntity") {
    return {
      requirementStatus: "cloudflare-default-entity-replacement",
      implementationStatus: "complete",
      approvalStatus: "user-directed",
      evidence:
        "migration 0064; cloudflare/src/api/billing-entities.ts; cloudflare/operator-app billing-profile route",
      contractFamily: "default-billing-entity",
    };
  }
  if (coreSafetyDisabledPatterns.some((pattern) => pattern.test(operation.name))) {
    return {
      requirementStatus: "safety-disabled",
      implementationStatus: "complete",
      approvalStatus: "user-directed",
      evidence:
        "cloudflare/src/operator/index.ts; operator-access.test.ts; explicit unsafe-external-action boundary",
      contractFamily: "unsafe-external-action",
    };
  }
  const contract = coreOperationContracts.find(
    (candidate) =>
      candidate.patterns.some((pattern) => pattern.test(operation.name)) &&
      !(candidate.exclude ?? []).some((pattern) => pattern.test(operation.name)),
  );
  if (!contract) return null;
  return {
    requirementStatus: "required",
    implementationStatus: "complete",
    approvalStatus: "not-requested",
    evidence: contract.evidence ?? coreEvidence,
    contractFamily: contract.family,
  };
}

const coreRouteContracts = [
  {
    family: "unsafe-external-route",
    patterns: [
      /^CREATE_(?:INVOICE_)?PAYMENT_ROUTE$/,
      /^CREATE_PAYMENT_ROUTE$/,
      /^(?:CREATE|UPDATE)_WEBHOOK_ROUTE$/,
      /^CREATE_WALLET_TOP_UP_ROUTE$/,
      /^VOID_CREATE_WALLET_TOP_UP_ROUTE$/,
    ],
    requirementStatus: "safety-disabled",
    approvalStatus: "user-directed",
    evidence:
      "cloudflare/operator-app; cloudflare/src/operator/index.ts; explicit unsafe-external-action boundary",
  },
  {
    family: "default-billing-entity-route",
    patterns: [/^BILLING_ENTITY_CREATE_ROUTE$/],
    requirementStatus: "cloudflare-default-entity-replacement",
    approvalStatus: "user-directed",
    evidence:
      "migration 0064; cloudflare/src/api/billing-entities.ts; cloudflare/operator-app billing-profile route",
  },
  {
    family: "core-operator-route",
    patterns: [
      /^(?:CREATE_|UPDATE_)?ADD_ON(?:_DETAILS|S)?_ROUTE$/,
      /^(?:CREATE_|UPDATE_)?COUPON(?:_DETAILS|S)?_ROUTE$/,
      /^API_KEYS_ROUTE$/,
      /^CREATE_API_KEYS_ROUTE$/,
      /^UPDATE_API_KEYS_ROUTE$/,
      /^BILLING_ENTITY_(?:DUNNING_CAMPAIGNS|EMAIL_SCENARIOS(?:_CONFIG)?|GENERAL|INVOICE_CUSTOM_SECTIONS|INVOICE_SETTINGS|TAXES_SETTINGS|UPDATE)_ROUTE$/,
      /^CREATE_ALERT_(?:CUSTOMER|PLAN)_SUBSCRIPTION_ROUTE$/,
      /^CREATE_ALERT_WALLET_ROUTE$/,
      /^UPDATE_ALERT_(?:CUSTOMER|PLAN)_SUBSCRIPTION_ROUTE$/,
      /^UPDATE_ALERT_WALLET_ROUTE$/,
      /^CREATE_ENTITLEMENT_(?:CUSTOMER|PLAN)_SUBSCRIPTION_ROUTE$/,
      /^UPDATE_ENTITLEMENT_(?:CUSTOMER|PLAN)_SUBSCRIPTION_ROUTE$/,
      /^CREATE_CUSTOMER_ROUTE$/,
      /^UPDATE_CUSTOMER_ROUTE$/,
      /^CREATE_DUNNING_ROUTE$/,
      /^UPDATE_DUNNING_ROUTE$/,
      /^CREATE_INVOICE_ROUTE$/,
      /^CREATE_PLAN_ROUTE$/,
      /^UPDATE_PLAN_ROUTE$/,
      /^CREATE_TAX_ROUTE$/,
      /^UPDATE_TAX_ROUTE$/,
      /^CREATE_WALLET_ROUTE$/,
      /^CREDIT_NOTES_ROUTE$/,
      /^CUSTOMER_.+_ROUTE$/,
      /^CUSTOMERS_LIST_ROUTE$/,
      /^DEVTOOL_ROUTE$/,
      /^DUNNINGS_SETTINGS_ROUTE$/,
      /^EDIT_PROGRESSIVE_BILLING_(?:CUSTOMER|PLAN)_SUBSCRIPTION_ROUTE$/,
      /^EDIT_WALLET_ROUTE$/,
      /^(?:EMAILS|GENERAL|INVOICE|TAXES)_SETTINGS_ROUTE$/,
      /^(?:ERROR_404|FORBIDDEN|HOME|SETTINGS)_ROUTE$/,
      /^(?:INVOICES|PAYMENTS|PLANS|SUBSCRIPTIONS)_ROUTE$/,
      /^(?:PAYMENT|PLAN|PLAN_SUBSCRIPTION|WALLET)_DETAILS_ROUTE$/,
      /^VOID_CREATE_INVOICE_ROUTE$/,
      /^WEBHOOKS?_ROUTE$/,
    ],
    requirementStatus: "required",
    approvalStatus: "not-requested",
    evidence:
      "cloudflare/operator-app routeDefinitions and original-route aliases; operator-app-assets.test.ts",
  },
];

function coreRouteContract(route) {
  const contract = coreRouteContracts.find((candidate) =>
    candidate.patterns.some((pattern) => pattern.test(route.name)),
  );
  if (!contract) return null;
  return {
    requirementStatus: contract.requirementStatus,
    implementationStatus: "complete",
    approvalStatus: contract.approvalStatus,
    completionEligible: true,
    evidence: contract.evidence,
    contractFamily: contract.family,
  };
}

function matchesAny(values, patterns) {
  return values.some((value) => patterns.some((pattern) => pattern.test(value)));
}

function surfaceForOperation(operation) {
  return surfaces.find(
    (surface) =>
      matchesAny([operation.name], surface.operationNamePatterns ?? []) ||
      matchesAny(operation.sources, surface.sourcePatterns),
  );
}

function surfaceForRoute(route) {
  return surfaces.find(
    (surface) =>
      matchesAny([route.name, route.value], surface.routePatterns) ||
      matchesAny(route.sources, surface.sourcePatterns),
  );
}

const operations = originalOperations.map((operation) => {
  const surface = surfaceForOperation(operation);
  if (!surface) throw new Error(`No parity surface matched operation ${operation.name}`);
  const coreContract = surface.id === "core-operator" ? coreOperationContract(operation) : null;
  const safetyDisabled =
    operation.name === "retryWebhook" ||
    (surface.id === "integrations" &&
      /retry|trigger|refetch|paymentmethod|api.?key|authorizeurl/i.test(operation.name));
  const accessReplacement =
    surface.id === "identity-team" &&
    /login|signup|password|google|okta|authenticationmethod|role/i.test(operation.name);
  const portalSafetyDisabled =
    surface.id === "customer-portal" && operation.name === "TopUpPortalWallet";
  return {
    name: operation.name,
    kind: operation.kind,
    sources: operation.sources,
    surface: surface.id,
    requirementStatus:
      coreContract?.requirementStatus ??
      (safetyDisabled || portalSafetyDisabled
        ? "safety-disabled"
        : accessReplacement
          ? "cloudflare-access-replacement"
          : "required"),
    implementationStatus: coreContract?.implementationStatus ?? surface.implementationStatus,
    approvalStatus:
      coreContract?.approvalStatus ??
      (safetyDisabled || portalSafetyDisabled || accessReplacement
        ? "user-directed"
        : "not-requested"),
    completionEligible:
      (coreContract?.implementationStatus ?? surface.implementationStatus) === "complete",
    evidence: coreContract?.evidence ?? surface.evidence ?? null,
    contractFamily: coreContract?.contractFamily ?? surface.id,
    previousDisposition: operation.disposition,
    previousMappingStatus: operation.mappingStatus,
  };
});

const routes = originalRoutes.map((route) => {
  const surface = surfaceForRoute(route);
  if (!surface) throw new Error(`No parity surface matched route ${route.name}`);
  const coreContract = surface.id === "core-operator" ? coreRouteContract(route) : null;
  if (surface.id === "core-operator" && !coreContract) {
    throw new Error(`No executable core route contract matched ${route.name}`);
  }
  return {
    name: route.name,
    value: route.value,
    sources: route.sources,
    surface: surface.id,
    requirementStatus: coreContract?.requirementStatus ?? "required",
    implementationStatus: coreContract?.implementationStatus ?? surface.implementationStatus,
    approvalStatus: coreContract?.approvalStatus ?? "not-requested",
    completionEligible:
      coreContract?.completionEligible ?? surface.implementationStatus === "complete",
    evidence: coreContract?.evidence ?? surface.evidence ?? null,
    contractFamily: coreContract?.contractFamily ?? surface.id,
    previousDisposition: route.disposition,
    previousMappingStatus: route.mappingStatus,
  };
});

const surfaceRows = surfaces.map((surface) => {
  const surfaceOperations = operations.filter((operation) => operation.surface === surface.id);
  const surfaceRoutes = routes.filter((route) => route.surface === surface.id);
  const complete =
    surfaceOperations.every((operation) => operation.implementationStatus === "complete") &&
    surfaceRoutes.every((route) => route.implementationStatus === "complete");
  return {
    id: surface.id,
    name: surface.name,
    implementationStatus: complete ? "complete" : surface.implementationStatus,
    operationCount: surfaceOperations.length,
    routeCount: surfaceRoutes.length,
    contract: surface.contract,
    notes: surface.notes,
    evidence: surface.evidence ?? (complete ? coreEvidence : null),
  };
});

const ledger = {
  schemaVersion: 1,
  sourceInventory: "docs/reference/cloudflare-rewrite-feature-inventory.json",
  policy: {
    sourceOfTruth:
      "The checked-in original Lago frontend is the product source of truth until the user explicitly approves an omission or replacement.",
    completionRule:
      "A classification, placeholder, disabled route, or unreachable legacy GraphQL operation is not parity. Completion requires executable Cloudflare behavior and evidence, or explicit user approval for a named omission.",
    approvalRule:
      "No prior blocked, external, not-used, or retired classification is treated as product approval.",
  },
  summary: {
    originalOperations: operations.length,
    originalRoutes: routes.length,
    testedRestReplacementFamilies: restReplacements.length,
    byImplementationStatus: Object.fromEntries(
      [...new Set(operations.map((operation) => operation.implementationStatus))]
        .sort()
        .map((status) => [
          status,
          operations.filter((operation) => operation.implementationStatus === status).length,
        ]),
    ),
    completionEligibleOperations: operations.filter((operation) => operation.completionEligible)
      .length,
    completionEligibleRoutes: routes.filter((route) => route.completionEligible).length,
  },
  surfaces: surfaceRows,
  restReplacements,
  operations,
  routes,
};

if (operations.length !== inventory.operatorSurface.summary.operations) {
  throw new Error("The parity ledger does not cover every original Lago GraphQL operation");
}
if (routes.length !== inventory.operatorSurface.summary.literalRouteConstants) {
  throw new Error("The parity ledger does not cover every original Lago route constant");
}

const json = `${JSON.stringify(ledger, null, 2)}\n`;
const markdown = `# Cloudflare Operator Authoritative Parity Ledger

Generated from \`docs/reference/cloudflare-rewrite-feature-inventory.json\`.

## Completion rule

The checked-in original Lago frontend is the product source of truth. A classification,
placeholder, disabled route, or unreachable legacy GraphQL operation is **not** parity. A surface
is complete only when its Cloudflare-native behavior has executable evidence, or the user has
explicitly approved that named omission or replacement.

No earlier \`blocked\`, \`external\`, \`not-used\`, or \`retired\` classification is treated as product
approval.

## Current baseline

- Original GraphQL operations: **${operations.length}**
- Original literal route constants: **${routes.length}**
- Tested Access-scoped REST replacement families: **${restReplacements.length}**
- Operations currently eligible to count as complete: **${ledger.summary.completionEligibleOperations}**
- Routes currently eligible to count as complete: **${ledger.summary.completionEligibleRoutes}**

Completion eligibility is evidence-driven. The remediated product surfaces count only because
their original operations and routes now map to executable Cloudflare behavior and focused tests.
Unreconciled surfaces remain ineligible even when related REST families exist.

## Surface ledger

| Surface | State | Operations | Routes | Required Cloudflare contract | Evidence / remaining gap |
| --- | --- | ---: | ---: | --- | --- |
${surfaceRows
  .map(
    (surface) =>
      `| ${surface.name} | ${surface.implementationStatus} | ${surface.operationCount} | ${surface.routeCount} | ${surface.contract} | ${surface.evidence ?? surface.notes} |`,
  )
  .join("\n")}

## Machine-readable operation ledger

Every one of the ${operations.length} operations and ${routes.length} routes, including its original
source file, previous disposition, current required surface, and evidence state, is recorded in
\`docs/reference/cloudflare-operator-parity-ledger.json\`. The generator fails if any original
operation or route is absent.
`;

function check(path, expected) {
  let current = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // The comparison below reports the actionable failure.
  }
  if (current !== expected) {
    console.error(
      `Operator parity ledger is stale: ${path.replace(`${repositoryDirectory}/`, "")}`,
    );
    process.exitCode = 1;
  }
}

if (checkOnly) {
  check(jsonOutputPath, json);
  check(markdownOutputPath, markdown);
  if (!process.exitCode) console.log("Operator parity ledger is current");
} else {
  writeFileSync(jsonOutputPath, json);
  writeFileSync(markdownOutputPath, markdown);
  console.log("Wrote authoritative operator parity ledger");
}
