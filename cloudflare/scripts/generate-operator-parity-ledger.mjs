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
    routePatterns: [/ACTIVITY_LOG/i, /API_LOG/i, /WEBHOOK_LOG/i, /EVENT/i],
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
    routePatterns: [/CUSTOMER_PORTAL/i],
    implementationStatus: "missing",
    contract: "Separate public-token Worker contract and customer-safe projections",
    notes: "A separate security boundary is required, but the product surface remains unfinished.",
  },
  {
    id: "identity-team",
    name: "Identity, invitations, team, roles, and authentication settings",
    sourcePatterns: [/\/auth\//i, /Invitation/i, /teamAndSecurity/i, /UserIdentifier/i],
    routePatterns: [/AUTH/i, /INVIT/i, /MEMBER/i, /ROLE/i, /TEAM/i, /SIGN/i, /LOGIN/i],
    implementationStatus: "partial",
    contract: "Cloudflare Access authentication plus D1 organization memberships and role policy",
    notes:
      "Access replaces operator login, but invitations, membership lifecycle, role administration, and related settings are not complete.",
  },
  {
    id: "integrations",
    name: "Provider, accounting, CRM, tax, and payment integrations",
    sourcePatterns: [/\/integrations\//i, /Integration/i, /paymentMethodsList/i],
    routePatterns: [/INTEGRATION/i, /PAYMENT_PROVIDER/i, /PAYMENT_METHOD/i],
    implementationStatus: "missing",
    contract: "Provider-specific secret-safe Worker adapters behind disabled-by-default gates",
    notes:
      "No integration may be silently removed. Each requires implementation or explicit user approval to omit.",
  },
  {
    id: "core-operator",
    name: "Core billing and configuration operator",
    sourcePatterns: [/.*/],
    routePatterns: [/.*/],
    implementationStatus: "partial",
    contract: `${restReplacements.length} tested Access-scoped REST replacement families`,
    notes:
      "The current pages cover bounded subsets. Exact original fields, tabs, filters, logs, advanced actions, and failure states still require operation-level verification.",
  },
];

function matchesAny(values, patterns) {
  return values.some((value) => patterns.some((pattern) => pattern.test(value)));
}

function surfaceForOperation(operation) {
  return surfaces.find((surface) => matchesAny(operation.sources, surface.sourcePatterns));
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
  const safetyDisabled = operation.name === "retryWebhook";
  return {
    name: operation.name,
    kind: operation.kind,
    sources: operation.sources,
    surface: surface.id,
    requirementStatus: safetyDisabled ? "safety-disabled" : "required",
    implementationStatus: surface.implementationStatus,
    approvalStatus: safetyDisabled ? "user-directed" : "not-requested",
    completionEligible: surface.implementationStatus === "complete",
    evidence: surface.evidence ?? null,
    previousDisposition: operation.disposition,
    previousMappingStatus: operation.mappingStatus,
  };
});

const routes = originalRoutes.map((route) => {
  const surface = surfaceForRoute(route);
  if (!surface) throw new Error(`No parity surface matched route ${route.name}`);
  return {
    name: route.name,
    value: route.value,
    sources: route.sources,
    surface: surface.id,
    requirementStatus: "required",
    implementationStatus: surface.implementationStatus,
    approvalStatus: "not-requested",
    completionEligible: surface.implementationStatus === "complete",
    evidence: surface.evidence ?? null,
    previousDisposition: route.disposition,
    previousMappingStatus: route.mappingStatus,
  };
});

const surfaceRows = surfaces.map((surface) => ({
  id: surface.id,
  name: surface.name,
  implementationStatus: surface.implementationStatus,
  operationCount: operations.filter((operation) => operation.surface === surface.id).length,
  routeCount: routes.filter((route) => route.surface === surface.id).length,
  contract: surface.contract,
  notes: surface.notes,
  evidence: surface.evidence ?? null,
}));

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
