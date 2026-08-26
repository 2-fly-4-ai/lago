import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const repositoryDirectory = resolve(packageDirectory, "..");
const outputFile = resolve(
  repositoryDirectory,
  "docs/reference/cloudflare-rewrite-feature-inventory.json",
);
const checkOnly = process.argv.includes("--check");

function filesBelow(
  root,
  predicate = () => true,
  sourcePrefix = relative(repositoryDirectory, root),
) {
  const result = [];
  if (!statSafe(root)?.isDirectory()) return result;

  function walk(directory) {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = join(directory, entry);
      const stat = statSafe(absolute);
      if (!stat) continue;
      if (stat.isDirectory()) walk(absolute);
      if (stat.isFile() && predicate(absolute))
        result.push(join(sourcePrefix, relative(root, absolute)));
    }
  }

  walk(root);
  return result;
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function gitRevision(path) {
  try {
    return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitTimestamp(path) {
  try {
    return execFileSync("git", ["-C", path, "show", "-s", "--format=%cI", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function gitTreeRevision(repository, path) {
  try {
    const entry = execFileSync("git", ["-C", repository, "ls-tree", "HEAD", "--", path], {
      encoding: "utf8",
    }).trim();
    return entry.split(/\s+/)[2] ?? null;
  } catch {
    return null;
  }
}

function primaryCheckout(repository) {
  try {
    const commonDirectory = execFileSync(
      "git",
      ["-C", repository, "rev-parse", "--git-common-dir"],
      {
        encoding: "utf8",
      },
    ).trim();
    const absolute = resolve(repository, commonDirectory);
    return dirname(absolute);
  } catch {
    return repository;
  }
}

function gitFilesBelow(root, pathPrefix, predicate = () => true, sourcePrefix = pathPrefix) {
  try {
    return execFileSync(
      "git",
      ["-C", root, "ls-tree", "-r", "--name-only", "HEAD", "--", pathPrefix],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    )
      .split("\n")
      .filter(Boolean)
      .filter(predicate)
      .sort()
      .map((source) => join(sourcePrefix, relative(pathPrefix, source)));
  } catch {
    return filesBelow(join(root, pathPrefix), predicate, sourcePrefix);
  }
}

function topLevelCounts(files, prefix) {
  const counts = new Map();
  for (const file of files) {
    const remainder = file.slice(prefix.length).replace(/^\//, "");
    const [first = "(root)", second] = remainder.split("/");
    const key = second ? first : "(root)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function operatorDomain(source) {
  const parts = source.replace(/^front\/src\//, "").split("/");
  if (parts[0] === "components" || parts[0] === "pages") {
    return parts.slice(0, 2).join("/");
  }
  return parts[0] || "(root)";
}

function countBy(values, keyFor) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFor(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

const operatorRestReplacements = [
  ["organization", "/api/operator/v1/organization", "read"],
  ["billing-entity", "/api/operator/v1/billing-entities", "read/admin-write"],
  ["api-keys", "/api/operator/v1/api-keys", "read/admin-write"],
  ["invoice-custom-sections", "/api/operator/v1/invoice-custom-sections", "read/admin-write"],
  ["payment-receipts", "/api/operator/v1/payment-receipts", "read-only"],
  ["taxes", "/api/operator/v1/taxes", "read/admin-write"],
  ["add-ons", "/api/operator/v1/add-ons", "read/admin-write"],
  ["customers", "/api/operator/v1/customers", "read/admin-write"],
  ["coupons", "/api/operator/v1/coupons", "read/admin-write"],
  ["applied-coupons", "/api/operator/v1/applied-coupons", "read/admin-write"],
  ["plans", "/api/operator/v1/plans", "read/admin-write"],
  ["subscriptions", "/api/operator/v1/subscriptions", "read/admin-write"],
  ["invoices", "/api/operator/v1/invoices", "read/admin-write"],
  ["wallets", "/api/operator/v1/wallets", "read/admin-write"],
  ["wallet-transactions", "/api/operator/v1/wallet-transactions", "read/admin-write"],
  ["credit-notes", "/api/operator/v1/credit-notes", "read/admin-write"],
  ["payments", "/api/operator/v1/payments", "read-only"],
  ["quotes", "/api/operator/v1/quotes", "read/admin-write"],
  ["data-exports", "/api/operator/v1/data-exports", "read/admin-create"],
  ["webhook-endpoints", "/api/operator/v1/webhook-endpoints", "read-only"],
  ["dunning-campaigns", "/api/operator/v1/dunning-campaigns", "read/admin-write"],
  ["payment-requests", "/api/operator/v1/payment-requests", "read-only"],
].map(([family, route, access]) => ({ family, route, access, parityStatus: "tested" }));

function legacyOperatorDisposition(sources) {
  const joined = sources.join("\n").toLowerCase();
  if (joined.includes("designsystem")) {
    return { disposition: "retire", mappingStatus: "legacy-route-retired" };
  }
  if (joined.includes("customerportal")) {
    return { disposition: "blocked", mappingStatus: "blocked-separate-public-contract" };
  }
  if (
    joined.includes("/auth/") ||
    joined.includes("invitation") ||
    joined.includes("teamandsecurity")
  ) {
    return { disposition: "blocked", mappingStatus: "blocked-access-identity-lifecycle" };
  }
  if (joined.includes("/features/") || joined.includes("entitlement")) {
    return { disposition: "external", mappingStatus: "external-serp-auth" };
  }
  if (
    joined.includes("/integrations/") ||
    joined.includes("aiagent") ||
    joined.includes("paymentmethodslist")
  ) {
    return { disposition: "not-used", mappingStatus: "legacy-integration-not-used" };
  }
  if (
    joined.includes("analytics") ||
    joined.includes("graphs") ||
    joined.includes("dashboards") ||
    joined.includes("forecasts") ||
    joined.includes("alert") ||
    joined.includes("webhooklog") ||
    joined.includes("apilog")
  ) {
    return { disposition: "blocked", mappingStatus: "deferred-bounded-read-contract" };
  }
  return { disposition: "port", mappingStatus: "legacy-graphql-disabled" };
}

function extractOperatorSurface(frontRoot) {
  const sourceRoot = join(frontRoot, "src");
  const generatedOperations = new Set();
  const generatedGraphql = readFileSync(join(sourceRoot, "generated", "graphql.tsx"), "utf8");
  for (const match of generatedGraphql.matchAll(
    /export type ([A-Za-z0-9_]+?)(Query|Mutation|Subscription)Variables\b/g,
  )) {
    generatedOperations.add(`${match[2].toLowerCase()}:${match[1]}`);
  }
  const sourceFiles = filesBelow(
    sourceRoot,
    (path) => {
      const segments = path.split(sep);
      return (
        /\.(ts|tsx)$/.test(path) &&
        !segments.includes("generated") &&
        !segments.includes("__tests__") &&
        !segments.includes("__mocks__") &&
        !segments.includes("test-utils") &&
        !/\.(test|spec)\.(ts|tsx)$/.test(path)
      );
    },
    "front/src",
  );
  const operations = new Map();
  const routes = new Map();

  for (const source of sourceFiles) {
    const absolute = resolve(frontRoot, relative("front", source));
    const contents = readFileSync(absolute, "utf8");
    for (const document of contents.matchAll(/\bgql\s*`([\s\S]*?)`/g)) {
      for (const match of document[1].matchAll(
        /(?:^|\n)[ \t]*(query|mutation|subscription)[ \t]+([A-Za-z_][A-Za-z0-9_]*)\b/g,
      )) {
        const [, kind, name] = match;
        const key = `${kind}:${name}`;
        const operation = operations.get(key) ?? { name, kind, sources: [] };
        if (!operation.sources.includes(source)) operation.sources.push(source);
        operations.set(key, operation);
      }
    }
    for (const match of contents.matchAll(
      /export\s+const\s+([A-Z][A-Z0-9_]*(?:ROUTE|BASE)[A-Z0-9_]*)\s*=\s*(["'`])([^"'`]+)\2/g,
    )) {
      const [, name, , value] = match;
      if (!value.startsWith("/") && !value.startsWith("${")) continue;
      const key = `${name}:${value}`;
      const route = routes.get(key) ?? { name, value, sources: [] };
      if (!route.sources.includes(source)) route.sources.push(source);
      routes.set(key, route);
    }
  }

  const sourcedOperationKeys = new Set(
    [...operations.values()].map(
      (operation) =>
        `${operation.kind}:${operation.name.slice(0, 1).toUpperCase()}${operation.name.slice(1)}`,
    ),
  );
  const missingGeneratedOperations = [...generatedOperations].filter(
    (operation) => !sourcedOperationKeys.has(operation),
  );
  if (missingGeneratedOperations.length > 0) {
    throw new Error(
      `Generated frontend operations are missing source documents: ${missingGeneratedOperations.join(", ")}`,
    );
  }

  const operationList = [...operations.values()]
    .map((operation) => {
      const sources = operation.sources.sort();
      const mapping = legacyOperatorDisposition(sources);
      return {
        ...operation,
        sources,
        generated: generatedOperations.has(
          `${operation.kind}:${operation.name.slice(0, 1).toUpperCase()}${operation.name.slice(1)}`,
        ),
        owner: "lago-operator-ui",
        consumers: ["lago-operators"],
        disposition: mapping.disposition,
        target: "cloudflare/operator-app plus membership-scoped REST BFF",
        parityStatus: "explicit-boundary",
        mappingStatus: mapping.mappingStatus,
        migrationNotes:
          "The legacy React/Apollo bundle is not deployed. Tested replacements are inventoried separately; every other legacy operation remains unreachable.",
        rollbackNotes:
          "Restore the script-free migration shell or disable the Access application; never deploy the legacy GraphQL bundle as fallback.",
      };
    })
    .sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
    );
  const routeList = [...routes.values()]
    .map((route) => {
      const sources = route.sources.sort();
      const mapping = legacyOperatorDisposition(sources);
      return {
        ...route,
        sources,
        owner: "lago-operator-ui",
        disposition: mapping.disposition,
        target: "Cloudflare Workers Static Assets",
        parityStatus: "explicit-boundary",
        mappingStatus: mapping.mappingStatus,
      };
    })
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value),
    );

  return {
    summary: {
      operations: operationList.length,
      queries: operationList.filter((operation) => operation.kind === "query").length,
      mutations: operationList.filter((operation) => operation.kind === "mutation").length,
      subscriptions: operationList.filter((operation) => operation.kind === "subscription").length,
      generatedOperations: generatedOperations.size,
      sourceOnlyOperations: operationList.filter((operation) => !operation.generated).length,
      missingGeneratedOperations: missingGeneratedOperations.length,
      literalRouteConstants: routeList.length,
      restReplacementFamilies: operatorRestReplacements.length,
    },
    operationDomains: countBy(operationList, (operation) =>
      operatorDomain(operation.sources[0] ?? "front/src/(unknown)"),
    ),
    operations: operationList,
    restReplacements: operatorRestReplacements,
    routes: routeList,
  };
}

const jobRules = [
  {
    pattern:
      /api\/app\/jobs\/(?:application_job|clock_job|concerns\/(?:concurrency_throttlable|sentry_cron_concern))\.rb$/i,
    disposition: "retire",
    target: "Cloudflare Workers, Queues, Workflows, Cron Triggers, and native observability",
    evidence: ["cloudflare/test/health.test.ts", "cloudflare/test/scheduled-maintenance.test.ts"],
    migrationNotes:
      "These files are Rails, Active Job, Sidekiq throttling, and Sentry-Cron scaffolding rather than domain commands. Cloudflare supplies the runtime, retry, concurrency, schedule, and observability owners directly.",
    rollbackNotes:
      "Keep the legacy runtime available only until the separately approved cutover; do not copy framework base classes into the Worker package.",
  },
  {
    pattern: /api\/app\/jobs\/database_migrations\/.*\.rb$/i,
    disposition: "not-used",
    target: "cloudflare/migrations/ forward-only D1 schema and separately approved cutover tooling",
    evidence: ["cloudflare/migrations/0001_foundation.sql", "cloudflare/test/setup.ts"],
    migrationNotes:
      "These are historical PostgreSQL row backfills, including already-retired provider fields. Empty D1 databases replay forward migrations; legacy production data movement belongs to the separate cutover plan and must not run as an application job.",
    rollbackNotes:
      "Do not enqueue historical Rails backfills against D1. Keep production data migration outside this isolated rewrite until explicitly approved.",
  },
  {
    pattern:
      /api\/app\/jobs\/(?:ai_conversations\/.*|segment_(?:identify|track)_job|integrations\/.*|integration_customers\/.*|usage_monitoring\/.*)\.rb$/i,
    disposition: "not-used",
    target: "No retained SERP Lago runtime contract",
    evidence: [
      "cloudflare/README.md",
      "docs/plans/completed/2026-08-12-cloudflare-native-rewrite.md",
    ],
    migrationNotes:
      "Read-only consumer audits found no Lago API dependency for AI conversation streaming, Segment telemetry, CRM/accounting/tax integrations, integration-customer fanout, or Lago premium usage-alert delivery.",
    rollbackNotes:
      "If an owning SERP repository adopts one of these capabilities, add its exact contract behind disabled external-action gates with synthetic fixtures before enabling it.",
  },
  {
    pattern:
      /api\/app\/jobs\/(?:credit_notes\/refunds\/.*|invoices\/payments\/(?:adyen|gocardless|moneyhash|stripe)_create_job|payment_provider_customers\/.*|payment_providers\/(?:adyen|cashfree|flutterwave|gocardless|moneyhash|stripe)\/.*|payment_providers\/cancel_payment_authorization_job|payment_requests\/payments\/(?:adyen|gocardless|moneyhash|stripe)_create_job|payments\/set_payment_method_and_create_receipt_job)\.rb$/i,
    disposition: "not-used",
    target:
      "No retained Lago runtime; SERP commerce and entitlement recovery call Stripe directly from their owning Workers",
    evidence: [
      "cloudflare/README.md",
      "docs/plans/completed/2026-08-12-cloudflare-native-rewrite.md",
    ],
    migrationNotes:
      "These jobs are provider-specific to Lago-managed Stripe, Adyen, GoCardless, Cashfree, Flutterwave, or MoneyHash. The retained Lago adapter is Authorize.Net hosted payment only.",
    rollbackNotes:
      "Keep these provider mutations absent. Any later adoption requires a verified consumer and isolated fake-provider contract suite.",
  },
  {
    pattern:
      /api\/app\/jobs\/(?:bill_paid_credit_job|invoices\/prepaid_credit_job|subscriptions\/activation_rules\/payment\/resolve_job)\.rb$/i,
    disposition: "not-used",
    target: "Explicit provider-funded-credit and provider-gated-subscription boundaries",
    evidence: [
      "cloudflare/test/wallet-ledger.test.ts",
      "cloudflare/test/subscription-lifecycle.test.ts",
    ],
    migrationNotes:
      "Paid wallet funding and provider-gated subscription activation are outside the retained provider-free billing contract. Granted credits and supported subscription lifecycle commands have direct D1 owners.",
    rollbackNotes:
      "Do not enable provider-funded credits or payment-gated activation without a separately approved payment workflow and reconciliation contract.",
  },
  {
    pattern:
      /api\/app\/jobs\/(?:customers\/(?:retry_vies_check|terminate_relations|vies_check)_job|invoices\/finalize_pending_vies_invoice_job|taxes\/.*|(?:credit_notes|invoices)\/provider_taxes\/.*)\.rb$/i,
    disposition: "not-used",
    target: "Explicit VIES, destructive-customer, and external-tax-provider disabled boundaries",
    evidence: ["cloudflare/test/tax-ledger.test.ts", "cloudflare/test/billing-entities.test.ts"],
    migrationNotes:
      "The retained contract supports manual percentage taxes and non-destructive customer lifecycle. VIES, automatic EU tax management, external tax providers, and destructive relation teardown are not enabled.",
    rollbackNotes:
      "Keep these external/destructive paths rejected until their provider, data-retention, and reconciliation contracts are separately approved.",
  },
  {
    pattern: /api\/app\/jobs\/(?:credit_notes|invoices|payment_receipts)\/generate_xml_job\.rb$/i,
    disposition: "not-used",
    target: "Explicit e-invoicing-disabled document API boundaries",
    evidence: [
      "cloudflare/test/billing-entities.test.ts",
      "cloudflare/test/payment-receipt-document.test.ts",
      "cloudflare/test/credit-note-document.test.ts",
    ],
    migrationNotes:
      "Factur-X/UBL XML generation is unreachable because the retained single billing entity rejects e-invoicing configuration. PDF generation remains container-free through Browser Rendering.",
    rollbackNotes:
      "Do not enqueue XML work unless a separately approved e-invoicing slice supplies Workers-native generation and structural verification.",
  },
  {
    pattern:
      /api\/app\/jobs\/(?:send_email_job|invoices\/notify_job|payment_receipts\/notify_job)\.rb$/i,
    disposition: "not-used",
    target: "No retained Lago email-delivery contract",
    evidence: [
      "cloudflare/README.md",
      "docs/plans/completed/2026-08-12-cloudflare-native-rewrite.md",
    ],
    migrationNotes:
      "SERP does not consume Lago email delivery. Document generation and outbox evidence remain available without a mailer, SMTP process, or customer-message side effect.",
    rollbackNotes:
      "Customer messaging requires a separately approved owner, templates, delivery provider, consent policy, and synthetic tests.",
  },
  {
    pattern: /api\/app\/jobs\/events\/stores\/clickhouse\/.*\.rb$/i,
    disposition: "not-used",
    target: "D1 usage-event ledger and projections; no ClickHouse migration runtime",
    evidence: ["cloudflare/test/metered-usage.test.ts", "cloudflare/test/daily-usage.test.ts"],
    migrationNotes:
      "The Worker writes its authoritative D1/R2 usage model directly, so ClickHouse pre-enrichment and enriched-store migration orchestration have no source or destination.",
    rollbackNotes:
      "Do not recreate ClickHouse migration loops unless approved volume evidence selects ClickHouse as a product requirement.",
  },
  {
    pattern: /api\/app\/jobs\/clock\/.*\.rb$/i,
    target: "cloudflare/src/schedules/registry.ts and cloudflare/src/workflows/reconciliation.ts",
    evidence: ["cloudflare/test/scheduled-maintenance.test.ts"],
    migrationNotes:
      "The exhaustive one-minute registry assigns all 27 legacy Clockwork entries an executable or audited Cloudflare owner; no Rails clock queue remains.",
  },
  {
    pattern: /api\/app\/jobs\/(?:bill_non_invoiceable_fees_job|bill_subscription_job)\.rb$/i,
    target: "cloudflare/src/billing/close-period.ts and cloudflare/src/api/metered-usage.ts",
    evidence: ["cloudflare/test/billing-cycle.test.ts", "cloudflare/test/metered-usage.test.ts"],
  },
  {
    pattern:
      /api\/app\/jobs\/(?:billable_metric_filters\/.*|billable_metrics\/delete_events_job)\.rb$/i,
    target:
      "cloudflare/src/api/plan-catalog.ts, cloudflare/src/api/metered-usage.ts, and transactional retention tasks",
    evidence: ["cloudflare/test/plan-catalog.test.ts", "cloudflare/test/metered-usage.test.ts"],
  },
  {
    pattern: /api\/app\/jobs\/billing_entities\/taxes\/refresh_draft_invoices_job\.rb$/i,
    target: "cloudflare/src/api/billing-entities.ts and D1 draft invalidation triggers",
    evidence: ["cloudflare/test/billing-entities.test.ts", "cloudflare/test/billing-cycle.test.ts"],
  },
  {
    pattern: /api\/app\/jobs\/(?:charge_filters|charges|fixed_charges)\/.*\.rb$/i,
    target:
      "cloudflare/src/api/plan-catalog.ts and cloudflare/src/api/subscription-charge-filters.ts",
    evidence: [
      "cloudflare/test/subscription-charge-filters.test.ts",
      "cloudflare/test/charge-filters.test.ts",
    ],
  },
  {
    pattern:
      /api\/app\/jobs\/(?:credit_notes\/(?:generate_documents|generate_pdf)_job|invoices\/(?:generate_documents|generate_pdf|generate_pdf_and_notify)_job|payment_receipts\/(?:generate_documents|generate_pdf|generate_pdf_and_notify)_job)\.rb$/i,
    target: "cloudflare/src/documents/ and cloudflare/src/workflows/documents.ts",
    evidence: [
      "cloudflare/test/invoice-document.test.ts",
      "cloudflare/test/payment-receipt-document.test.ts",
      "cloudflare/test/credit-note-document.test.ts",
    ],
    migrationNotes:
      "Browser Rendering and the ownership-checked Document Workflow replace PDF jobs. Combined notify wrappers retain the PDF command while the unconsumed email side effect stays disabled.",
  },
  {
    pattern: /api\/app\/jobs\/customers\/refresh_wallet_job\.rb$/i,
    target: "cloudflare/src/schedules/wallet-balances.ts and cloudflare/src/api/wallet-ledger.ts",
    evidence: [
      "cloudflare/test/wallet-ongoing-balances.test.ts",
      "cloudflare/test/wallet-ledger.test.ts",
    ],
  },
  {
    pattern: /api\/app\/jobs\/daily_usages\/.*\.rb$/i,
    target: "cloudflare/src/usage/daily-usage.ts and cloudflare/src/workflows/reconciliation.ts",
    evidence: [
      "cloudflare/test/daily-usage.test.ts",
      "cloudflare/test/scheduled-maintenance.test.ts",
    ],
  },
  {
    pattern: /api\/app\/jobs\/data_exports\/.*\.rb$/i,
    target: "cloudflare/src/documents/data-export.ts and cloudflare/src/workflows/documents.ts",
    evidence: ["cloudflare/test/data-exports.test.ts"],
  },
  {
    pattern: /api\/app\/jobs\/dunning_campaigns\/.*\.rb$/i,
    target: "cloudflare/src/schedules/dunning.ts and cloudflare/src/workflows/reconciliation.ts",
    evidence: [
      "cloudflare/test/dunning-campaigns.test.ts",
      "cloudflare/test/scheduled-maintenance.test.ts",
    ],
  },
  {
    pattern:
      /api\/app\/jobs\/events\/(?:create_batch|pay_in_advance|post_process|post_validation)_job\.rb$/i,
    target: "cloudflare/src/api/metered-usage.ts and cloudflare/src/workflows/reconciliation.ts",
    evidence: [
      "cloudflare/test/metered-usage.test.ts",
      "cloudflare/test/scheduled-maintenance.test.ts",
    ],
  },
  {
    pattern: /api\/app\/jobs\/fees\/create_pay_in_advance_job\.rb$/i,
    target: "cloudflare/src/api/metered-usage.ts",
    evidence: ["cloudflare/test/metered-usage.test.ts"],
  },
  {
    pattern: /api\/app\/jobs\/inbound_webhooks\/process_job\.rb$/i,
    target:
      "cloudflare/src/webhooks/authorize-net.ts and cloudflare/src/reconciliation/authorize-net.ts",
    evidence: ["cloudflare/test/authorize-net-webhook.test.ts"],
  },
  {
    pattern:
      /api\/app\/jobs\/invoices\/(?:create_pay_in_advance_charge|create_pay_in_advance_fixed_charges)_job\.rb$/i,
    target:
      "cloudflare/src/api/metered-usage.ts and cloudflare/src/billing/pay-in-advance-fixed-charges.ts",
    evidence: [
      "cloudflare/test/metered-usage.test.ts",
      "cloudflare/test/pay-in-advance-fixed-charge.test.ts",
    ],
  },
  {
    pattern: /api\/app\/jobs\/invoices\/(?:finalize_all|finalize|refresh_draft)_job\.rb$/i,
    target: "cloudflare/src/billing/close-period.ts and cloudflare/src/api/lago-compatibility.ts",
    evidence: [
      "cloudflare/test/billing-cycle.test.ts",
      "cloudflare/test/invoice-finalization.test.ts",
    ],
  },
  {
    pattern:
      /api\/app\/jobs\/invoices\/(?:update_all_invoice_(?:grace_period|issuing_date)_from_billing_entity|update_(?:grace_period|issuing_date)_from_billing_entity)_job\.rb$/i,
    target: "cloudflare/src/api/billing-entities.ts and D1 draft invalidation triggers",
    evidence: [
      "cloudflare/test/billing-entities.test.ts",
      "cloudflare/test/invoice-finalization.test.ts",
    ],
  },
  {
    pattern: /api\/app\/jobs\/invoices\/payments\/mark_overdue_job\.rb$/i,
    target: "cloudflare/src/schedules/maintenance.ts",
    evidence: [
      "cloudflare/test/scheduled-maintenance.test.ts",
      "cloudflare/test/invoice-finalization.test.ts",
    ],
  },
  {
    pattern: /api\/app\/jobs\/invoices\/update_fees_payment_status_job\.rb$/i,
    target: "cloudflare/src/api/payment-ledger.ts and the normalized invoice/payment projection",
    evidence: ["cloudflare/test/payment-ledger.test.ts", "cloudflare/test/fees.test.ts"],
  },
  {
    pattern: /api\/app\/jobs\/invoices\/(?:payments\/(?:create|retry_all)_job|retry_all_job)\.rb$/i,
    disposition: "not-used",
    target: "Retained single-invoice Authorize.Net hosted-payment commands only",
    evidence: [
      "cloudflare/test/invoice-payment-retry.test.ts",
      "cloudflare/test/authorize-net-provider.test.ts",
    ],
    migrationNotes:
      "Generic automatic collection and operator bulk retry are not retained. The hosted-payment URL and single-invoice retry boundaries are explicit, idempotent, and kill-switched.",
    rollbackNotes:
      "Do not introduce provider-wide batch mutations without a verified consumer, reservation ledger, and fake-provider concurrency suite.",
  },
  {
    pattern: /api\/app\/jobs\/lifetime_usages\/.*\.rb$/i,
    target:
      "cloudflare/src/usage/lifetime-usage.ts, cloudflare/src/billing/progressive-billing.ts, and cloudflare/src/workflows/reconciliation.ts",
    evidence: [
      "cloudflare/test/lifetime-usage.test.ts",
      "cloudflare/test/progressive-billing.test.ts",
    ],
  },
  {
    pattern: /api\/app\/jobs\/payment_providers\/authorize_net\/handle_event_job\.rb$/i,
    target:
      "cloudflare/src/webhooks/authorize-net.ts and cloudflare/src/reconciliation/authorize-net.ts",
    evidence: ["cloudflare/test/authorize-net-webhook.test.ts"],
  },
  {
    pattern: /api\/app\/jobs\/payment_receipts\/create_job\.rb$/i,
    target: "cloudflare/src/api/payment-receipts.ts and atomic settlement commands",
    evidence: ["cloudflare/test/payment-receipts.test.ts"],
  },
  {
    pattern: /api\/app\/jobs\/payment_requests\/payments\/create_job\.rb$/i,
    target: "cloudflare/src/workflows/checkout.ts",
    evidence: [
      "cloudflare/test/payment-requests.test.ts",
      "cloudflare/test/checkout-workflow.test.ts",
    ],
  },
  {
    pattern: /api\/app\/jobs\/payments\/manual_create_job\.rb$/i,
    target: "cloudflare/src/api/payment-ledger.ts",
    evidence: ["cloudflare/test/payment-ledger.test.ts"],
  },
  {
    pattern: /api\/app\/jobs\/plans\/(?:destroy|update_amount)_job\.rb$/i,
    target: "cloudflare/src/api/plan-catalog.ts and cloudflare/src/billing/plan-deletion.ts",
    evidence: ["cloudflare/test/plan-catalog.test.ts"],
  },
  {
    pattern: /api\/app\/jobs\/send_(?:http_)?webhook_job\.rb$/i,
    target: "cloudflare/src/webhooks/outbound.ts and the domain-event Queue consumer",
    evidence: ["cloudflare/test/outbound-webhooks.test.ts"],
  },
  {
    pattern:
      /api\/app\/jobs\/subscriptions\/(?:flag_refreshed|organization_billing|terminate_ended_subscription|terminate)_job\.rb$/i,
    target:
      "cloudflare/src/api/subscription-lifecycle.ts, cloudflare/src/billing/close-period.ts, and cloudflare/src/workflows/reconciliation.ts",
    evidence: [
      "cloudflare/test/subscription-lifecycle.test.ts",
      "cloudflare/test/billing-cycle.test.ts",
      "cloudflare/test/scheduled-maintenance.test.ts",
    ],
  },
  {
    pattern: /api\/app\/jobs\/wallet_transactions\/create_job\.rb$/i,
    target: "cloudflare/src/api/wallet-ledger.ts",
    evidence: ["cloudflare/test/wallet-ledger.test.ts"],
  },
];

const portRules = [
  {
    pattern: /api\/app\/services\/utils\/pdf_attachment_service\.rb/i,
    disposition: "not-used",
    target:
      "Explicit e-invoicing-disabled boundaries in cloudflare/src/api/billing-entities.ts and document APIs",
    evidence: [
      "cloudflare/test/billing-entities.test.ts",
      "cloudflare/test/payment-receipt-document.test.ts",
      "cloudflare/test/credit-note-document.test.ts",
    ],
    migrationNotes:
      "pdfcpu only embeds generated Factur-X XML. The retained single billing entity rejects e-invoicing configuration, so this subprocess has no reachable Cloudflare runtime contract.",
    rollbackNotes:
      "Keep Factur-X XML and PDF/A-3 embedding disabled unless a separately approved e-invoicing product slice selects and verifies a Workers-native implementation.",
  },
  {
    pattern:
      /api\/app\/(controllers\/api\/v1\/payment_receipts_controller|jobs\/payment_receipts\/generate_(?:documents|pdf)_job|models\/payment_receipt|queries\/payment_receipts_query|serializers\/v1\/payment_receipt_serializer|services\/payment_receipts\/(?:create|generate_pdf)_service)\.rb/i,
    target:
      "cloudflare/src/api/payment-receipts.ts, cloudflare/src/documents/payment-receipt.ts, cloudflare/src/workflows/documents.ts, and cloudflare/migrations/0065-0066",
    evidence: [
      "cloudflare/test/payment-receipts.test.ts",
      "cloudflare/test/payment-receipt-document.test.ts",
    ],
  },
  {
    pattern:
      /api\/app\/(controllers\/api\/v1\/billing_entities_controller|models\/billing_entity|serializers\/v1\/billing_entity_serializer|services\/billing_entities\/update_service)\.rb/i,
    target: "cloudflare/src/api/billing-entities.ts",
    evidence: ["cloudflare/test/billing-entities.test.ts"],
  },
  {
    pattern:
      /api\/app\/(controllers\/api\/v1\/organizations_controller|models\/organization|serializers\/v1\/organization_serializer|services\/organizations\/update_service|graphql\/mutations\/organizations\/update)\.rb/i,
    target: "cloudflare/src/api/organizations.ts",
    evidence: ["cloudflare/test/organizations.test.ts"],
  },
  {
    pattern:
      /api\/app\/(controllers\/api\/v1\/fees_controller|models\/fee|queries\/fees_query|serializers\/v1\/fee_serializer|services\/fees\/(?:destroy|update)_service)\.rb/i,
    target: "cloudflare/src/api/fees.ts",
    evidence: ["cloudflare/test/fees.test.ts"],
  },
  {
    pattern:
      /api\/app\/(models\/api_key|services\/api_keys\/(?:create|destroy|rotate|update)_service|graphql\/(?:mutations\/api_keys\/(?:create|destroy|rotate|update)|resolvers\/api_keys_resolver|types\/api_keys\/(?:object|rotate_input|sanitized_object|update_input)))\.rb/i,
    target: "cloudflare/src/api/api-keys.ts and cloudflare/src/auth/api-key.ts",
    evidence: [
      "cloudflare/test/api-key-lifecycle.test.ts",
      "cloudflare/test/api-key-usage.test.ts",
    ],
  },
  {
    pattern:
      /api\/app\/(models\/dunning_campaign(?:_threshold)?|services\/(?:dunning_campaigns\/(?:bulk_process|create|destroy|process_attempt|update)_service|webhooks\/dunning_campaigns\/finished_service)|jobs\/(?:clock\/process_dunning_campaigns_job|dunning_campaigns\/(?:bulk_process|process_attempt)_job)|graphql\/(?:mutations\/dunning_campaigns\/(?:create|destroy|update)|resolvers\/dunning_campaigns?_resolver|types\/dunning_campaign))/i,
    target:
      "cloudflare/src/api/dunning-campaigns.ts, cloudflare/src/schedules/dunning.ts, and cloudflare/src/api/lago-compatibility.ts",
    evidence: [
      "cloudflare/test/dunning-campaigns.test.ts",
      "cloudflare/test/scheduled-maintenance.test.ts",
    ],
  },
  {
    pattern:
      /api\/app\/(controllers\/(api\/v1\/(customers\/)?payment_requests_controller|concerns\/payment_request_index)|models\/payment_request(\/applied_invoice)?|queries\/payment_requests_query|serializers\/v1\/payment_request_serializer|services\/payment_requests\/create_service)\.rb/i,
    target: "cloudflare/src/api/payment-requests.ts",
    evidence: ["cloudflare/test/payment-requests.test.ts"],
  },
  {
    pattern: /api\/app\/services\/invoices\/payments\/retry_service\.rb/i,
    target: "cloudflare/src/api/invoice-payment-retries.ts",
    evidence: ["cloudflare/test/invoice-payment-retry.test.ts"],
  },
  {
    pattern: /refresh_(dedicated_org_)?wallets_ongoing_balance/i,
    target: "cloudflare/src/schedules/registry.ts and cloudflare/src/schedules/wallet-balances.ts",
    evidence: [
      "cloudflare/test/wallet-ongoing-balances.test.ts",
      "cloudflare/test/scheduled-maintenance.test.ts",
    ],
  },
  {
    pattern: /retry_failed_invoices/i,
    target: "cloudflare/src/schedules/registry.ts and cloudflare/src/workflows/reconciliation.ts",
    evidence: ["cloudflare/test/scheduled-maintenance.test.ts"],
  },
  {
    pattern: /retry_generating_subscription_invoices/i,
    target:
      "cloudflare/src/schedules/registry.ts, cloudflare/src/workflows/reconciliation.ts, and cloudflare/src/billing/close-period.ts",
    evidence: [
      "cloudflare/test/scheduled-maintenance.test.ts",
      "cloudflare/test/billing-cycle.test.ts",
    ],
  },
  {
    pattern: /subscriptions_to_be_terminated|termination_alert_service/i,
    target: "cloudflare/src/billing/termination-alerts.ts",
    evidence: [
      "cloudflare/test/termination-alerts.test.ts",
      "cloudflare/test/scheduled-maintenance.test.ts",
    ],
  },
  {
    pattern: /api_keys\/track_usage|clock\/api_keys\/track_usage/i,
    target: "cloudflare/src/auth/api-key.ts",
    evidence: [
      "cloudflare/test/api-key-usage.test.ts",
      "cloudflare/test/scheduled-maintenance.test.ts",
    ],
  },
  {
    pattern: /usage_threshold|progressive_billing|lifetime_usages\/check_thresholds/i,
    target:
      "cloudflare/src/usage/thresholds.ts, cloudflare/src/billing/progressive-billing.ts, and cloudflare/src/billing/progressive-credit.ts",
    evidence: [
      "cloudflare/test/usage-thresholds.test.ts",
      "cloudflare/test/progressive-billing.test.ts",
      "cloudflare/test/subscription-plan-change.test.ts",
    ],
  },
  {
    pattern:
      /app\/(?:models\/(?:applied_invoice_custom_section|invoice_custom_section|(?:billing_entity|customer|subscription)\/applied_invoice_custom_section)\.rb|services\/(?:customers\/manage_invoice_custom_sections_service|invoice_custom_sections\/(?:attach_to_resource|create|deselect_all|destroy|update)_service|invoices\/apply_invoice_custom_sections_service)\.rb|serializers\/v1\/(?:applied_invoice_custom_section_serializer|invoice_custom_section_serializer|invoices\/applied_invoice_custom_section_serializer)\.rb|graphql\/.*invoice_custom_section)/i,
    target:
      "cloudflare/src/api/invoice-custom-sections.ts, cloudflare/src/api/lago-compatibility.ts, and cloudflare/src/subscriptions/custom-sections.ts",
    evidence: [
      "cloudflare/test/invoice-custom-sections.test.ts",
      "cloudflare/test/invoice-document.test.ts",
    ],
  },
  {
    pattern: /add_on|fixed_charge/i,
    target: "cloudflare/src/api/add-on-ledger.ts and cloudflare/src/billing/close-period.ts",
    evidence: ["cloudflare/test/add-on-fixed-charge.test.ts"],
  },
  {
    pattern: /coupon/i,
    target: "cloudflare/src/api/coupon-ledger.ts",
    evidence: ["cloudflare/test/coupon-ledger.test.ts"],
  },
  {
    pattern:
      /api\/app\/(jobs\/credit_notes\/generate_(?:documents|pdf)_job|services\/credit_notes\/generate_pdf_service)\.rb/i,
    target:
      "cloudflare/src/api/credit-note-ledger.ts, cloudflare/src/documents/credit-note.ts, cloudflare/src/workflows/documents.ts, and cloudflare/migrations/0067_credit_note_documents.sql",
    evidence: [
      "cloudflare/test/credit-note-ledger.test.ts",
      "cloudflare/test/credit-note-document.test.ts",
    ],
  },
  {
    pattern:
      /api\/app\/(models\/(?:credit_note|credit_note_item)|controllers\/api\/v1\/(?:customers\/)?credit_notes_controller|controllers\/concerns\/credit_note_index|services\/credit_notes\/(?:create_from_termination|create|recredit|refresh_draft|validate_item|validate|void)_service|services\/credits\/credit_note_service)\.rb/i,
    target: "cloudflare/src/api/credit-note-ledger.ts",
    evidence: ["cloudflare/test/credit-note-ledger.test.ts"],
  },
  {
    pattern: /wallet/i,
    target: "cloudflare/src/api/wallet-ledger.ts",
    evidence: ["cloudflare/test/wallet-ledger.test.ts"],
  },
  {
    pattern: /commitment/i,
    target: "cloudflare/src/billing/minimum-commitment.ts",
    evidence: ["cloudflare/test/billing-cycle.test.ts", "cloudflare/test/plan-catalog.test.ts"],
  },
  {
    pattern: /tax/i,
    target: "cloudflare/src/api/tax-ledger.ts",
    evidence: ["cloudflare/test/tax-ledger.test.ts"],
  },
  {
    pattern:
      /api\/app\/(models\/quote(?:_owner|_version)?|queries\/quotes_query|services\/(?:quotes|quote_versions)\/(?:approve|clone|create|update|void)_service|graphql\/(?:mutations|resolvers|types)\/.*quote.*)\.rb/i,
    target: "cloudflare/src/api/quotes.ts and cloudflare/migrations/0068_quote_versioning.sql",
    evidence: ["cloudflare/test/quotes.test.ts"],
  },
  {
    pattern:
      /api\/app\/(models\/data_export(?:_part)?|jobs\/data_exports\/.*|services\/data_exports\/.*|graphql\/(?:mutations|types)\/data_exports\/.*)\.rb/i,
    target:
      "cloudflare/src/api/data-exports.ts, cloudflare/src/documents/data-export.ts, cloudflare/src/workflows/documents.ts, and cloudflare/migrations/0069_data_exports.sql",
    evidence: ["cloudflare/test/data-exports.test.ts"],
  },
  {
    pattern: /document|generate_pdf|pdf_service|invoice.*file/i,
    target: "cloudflare/src/documents/invoice.ts",
    evidence: ["cloudflare/test/invoice-document.test.ts"],
  },
  {
    pattern: /billable_metric|events_controller|events\/|charge_model|charges\/calculate_price/i,
    target: "cloudflare/src/api/metered-usage.ts",
    evidence: [
      "cloudflare/test/metered-usage.test.ts",
      "cloudflare/test/usage-aggregation.test.ts",
      "cloudflare/test/rating.test.ts",
    ],
  },
  {
    pattern: /plans_controller|plans\/|plan_serializer/i,
    target: "cloudflare/src/api/plan-catalog.ts",
    evidence: ["cloudflare/test/plan-catalog.test.ts"],
  },
  {
    pattern: /subscriptions_controller|subscriptions\/|subscription_serializer/i,
    target: "cloudflare/src/api/subscription-lifecycle.ts",
    evidence: [
      "cloudflare/test/subscription-lifecycle.test.ts",
      "cloudflare/test/billing-cycle.test.ts",
    ],
  },
  {
    pattern: /adyen|cashfree|flutterwave|gocardless|moneyhash|stripe/i,
    disposition: "not-used",
    target:
      "No retained Lago runtime; SERP commerce and entitlement recovery call Stripe directly from their owning Workers",
    evidence: [
      "cloudflare/README.md",
      "docs/plans/completed/2026-08-12-cloudflare-native-rewrite.md",
    ],
    migrationNotes:
      "A read-only audit of the pinned store-new and serp-auth consumers found direct Stripe ownership and no Lago API dependency. Adyen, Cashfree, Flutterwave, GoCardless, MoneyHash, and Lago-managed Stripe therefore have no retained SERP runtime contract.",
    rollbackNotes:
      "Keep these adapters absent. If an owning SERP repository later adopts a Lago-managed provider contract, add that exact provider behind disabled mutation/read flags with synthetic contract fixtures before enabling it.",
  },
  {
    pattern: /authorize_net|authorize\/net/i,
    target: "cloudflare/src/providers/authorize-net.ts",
    evidence: [
      "cloudflare/test/authorize-net-provider.test.ts",
      "cloudflare/test/authorize-net-webhook.test.ts",
    ],
  },
  {
    pattern: /webhooks_controller|webhooks\/authorize_net/i,
    target: "cloudflare/src/webhooks/authorize-net.ts",
    evidence: ["cloudflare/test/authorize-net-webhook.test.ts"],
  },
  {
    pattern: /customer/i,
    target: "cloudflare/src/api/lago-compatibility.ts",
    evidence: ["cloudflare/fixtures/store-new/customer-upsert.json"],
  },
  {
    pattern: /subscription/i,
    target: "cloudflare/src/api/lago-compatibility.ts",
    evidence: ["cloudflare/fixtures/store-new/subscription-create.json"],
  },
  {
    pattern: /invoice/i,
    target: "cloudflare/src/api/lago-compatibility.ts",
    evidence: ["cloudflare/fixtures/store-new/invoice-list-query.json"],
  },
  {
    pattern: /^every\(/i,
    target: "cloudflare/src/schedules/registry.ts and cloudflare/src/workflows/reconciliation.ts",
    evidence: ["cloudflare/test/scheduled-maintenance.test.ts"],
  },
];

function disposition(source) {
  const owner = ownerFor(source);
  const consumers = consumersFor(source);
  const isJob = source.startsWith("api/app/jobs/");
  const match = (isJob ? jobRules : portRules).find((rule) => rule.pattern.test(source));
  if (isJob && !match) {
    throw new Error(`Active Job is missing an explicit Cloudflare disposition: ${source}`);
  }
  return match
    ? {
        source,
        owner,
        consumers,
        disposition: match.disposition ?? "port",
        target: match.target,
        evidence: match.evidence,
        testFixture: match.evidence[0] ?? null,
        parityStatus: "partial",
        migrationNotes:
          match.migrationNotes ??
          "Port incrementally behind isolated Cloudflare development resources.",
        rollbackNotes:
          match.rollbackNotes ??
          "Keep the legacy Lago path authoritative until parity and cutover approval.",
      }
    : {
        source,
        owner,
        consumers,
        disposition: "port",
        target: defaultTarget(owner),
        evidence: [source],
        testFixture: null,
        parityStatus: "not-started",
        migrationNotes:
          "Port or consolidate this behavior in the assigned Cloudflare component; do not assume a one-file-for-one-file translation.",
        rollbackNotes:
          "Keep the legacy Lago behavior authoritative until a contract fixture and parity evidence exist.",
      };
}

function defaultTarget(owner) {
  if (owner === "lago-api") return "cloudflare/src/api/";
  if (owner === "lago-domain") return "cloudflare/src/domain/";
  if (owner === "lago-service") return "cloudflare/src/billing/";
  if (owner === "lago-async") return "cloudflare/src/workflows/ or cloudflare/src/queues/";
  if (owner === "lago-graphql") return "cloudflare/src/operator-api/";
  if (owner === "lago-operator-ui") return "cloudflare/src/operator-ui/";
  return "cloudflare/src/";
}

function ownerFor(source) {
  if (source.includes("app/models/")) return "lago-domain";
  if (source.includes("app/controllers/")) return "lago-api";
  if (source.includes("app/services/")) return "lago-service";
  if (source.includes("app/jobs/") || source.startsWith("every(")) return "lago-async";
  if (source.includes("app/graphql/")) return "lago-graphql";
  if (source.startsWith("front/")) return "lago-operator-ui";
  return "lago";
}

function consumersFor(source) {
  if (source.includes("app/controllers/api/v1/") || source.includes("app/graphql/")) {
    return ["external-api-clients", "lago-operator-ui"];
  }
  if (source.startsWith("front/")) return ["lago-operators"];
  if (source.includes("app/jobs/") || source.startsWith("every(")) return ["lago-runtime"];
  return ["lago-internal"];
}

const primaryDirectory = primaryCheckout(repositoryDirectory);
const apiDirectory = resolve(process.env.LAGO_API_SOURCE ?? resolve(repositoryDirectory, "api"));
const frontDirectory = resolve(
  process.env.LAGO_FRONT_SOURCE ??
    (statSafe(resolve(repositoryDirectory, "front", ".git"))
      ? resolve(repositoryDirectory, "front")
      : resolve(primaryDirectory, "front")),
);
const pinnedApiRevision = gitTreeRevision(repositoryDirectory, "api");
const pinnedFrontRevision = gitTreeRevision(repositoryDirectory, "front");
const apiRevision = gitRevision(apiDirectory);
const frontRevision = gitRevision(frontDirectory);
for (const [name, pinned, actual] of [
  ["api", pinnedApiRevision, apiRevision],
  ["front", pinnedFrontRevision, frontRevision],
]) {
  if (!pinned || actual !== pinned) {
    throw new Error(
      `${name} source revision mismatch: expected ${pinned ?? "a pinned gitlink"}, found ${actual ?? "no checkout"}. Initialize the exact submodule revision before generating inventory.`,
    );
  }
}
const ruby = (path) => path.endsWith(".rb");
const models = gitFilesBelow(apiDirectory, "app/models", ruby, "api/app/models");
const controllers = gitFilesBelow(apiDirectory, "app/controllers", ruby, "api/app/controllers");
const services = gitFilesBelow(apiDirectory, "app/services", ruby, "api/app/services");
const jobs = gitFilesBelow(apiDirectory, "app/jobs", ruby, "api/app/jobs");
const graphql = gitFilesBelow(apiDirectory, "app/graphql", ruby, "api/app/graphql");
const migrations = gitFilesBelow(apiDirectory, "db/migrate", ruby, "api/db/migrate");
const frontSource = gitFilesBelow(
  frontDirectory,
  "src",
  (path) => /\.(ts|tsx|graphql)$/.test(path),
  "front/src",
);
const operatorSurface = extractOperatorSurface(frontDirectory);

const clockFile = join(apiDirectory, "clock.rb");
const schedules = statSafe(clockFile)
  ? readFileSync(clockFile, "utf8")
      .split("\n")
      .map((line, index) => ({ line: index + 1, source: line.trim() }))
      .filter(({ source }) => source.startsWith("every("))
  : [];
const jobFeatures = jobs.map(disposition);

const inventory = {
  schemaVersion: 1,
  generatedAt: gitTimestamp(apiDirectory),
  inputs: {
    apiRevision,
    apiPinnedRevision: pinnedApiRevision,
    frontRevision,
    frontPinnedRevision: pinnedFrontRevision,
  },
  policy: {
    allowedDispositions: ["port", "retire", "external", "blocked", "not-used", "unknown"],
    defaultDisposition: "port",
    retirementRequiresApproval: true,
    consolidationAllowed: true,
    jobsRequireExplicitDispositionRule: true,
    parityStatusMeaning:
      "partial means at least one behavior has executable evidence; not-started means the source is assigned but has no Cloudflare parity fixture yet",
  },
  summary: {
    models: models.length,
    controllers: controllers.length,
    services: services.length,
    jobs: jobs.length,
    jobDispositions: countBy(jobFeatures, (job) => job.disposition),
    graphqlFiles: graphql.length,
    migrations: migrations.length,
    schedules: schedules.length,
    frontSourceFiles: frontSource.length,
    frontGraphqlOperations: operatorSurface.summary.operations,
    frontGraphqlQueries: operatorSurface.summary.queries,
    frontGraphqlMutations: operatorSurface.summary.mutations,
    frontGraphqlSubscriptions: operatorSurface.summary.subscriptions,
    frontLiteralRouteConstants: operatorSurface.summary.literalRouteConstants,
  },
  domains: {
    services: topLevelCounts(services, "api/app/services"),
    jobs: topLevelCounts(jobs, "api/app/jobs"),
    graphql: topLevelCounts(graphql, "api/app/graphql"),
  },
  features: {
    models: models.map(disposition),
    controllers: controllers.map(disposition),
    services: services.map(disposition),
    jobs: jobFeatures,
    graphql: graphql.map(disposition),
    schedules: schedules.map((schedule) => ({
      ...schedule,
      ...disposition(schedule.source),
    })),
    front: frontSource.map(disposition),
  },
  operatorSurface,
};

const generated = `${JSON.stringify(inventory, null, 2)}\n`;
if (checkOnly) {
  let current = null;
  try {
    current = readFileSync(outputFile, "utf8");
  } catch {
    // The comparison below reports the actionable failure.
  }
  if (current !== generated) {
    console.error(`Feature inventory is stale: ${relative(repositoryDirectory, outputFile)}`);
    process.exitCode = 1;
  } else {
    console.log(`Feature inventory is current: ${relative(repositoryDirectory, outputFile)}`);
  }
} else {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, generated);
  console.log(`Wrote ${relative(repositoryDirectory, outputFile)}`);
}
