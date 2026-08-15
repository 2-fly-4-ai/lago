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
    .map((operation) => ({
      ...operation,
      sources: operation.sources.sort(),
      generated: generatedOperations.has(
        `${operation.kind}:${operation.name.slice(0, 1).toUpperCase()}${operation.name.slice(1)}`,
      ),
      owner: "lago-operator-ui",
      consumers: ["lago-operators"],
      disposition: "port",
      target: "Cloudflare REST compatibility or cloudflare/src/operator-api/",
      parityStatus: "not-started",
      mappingStatus: "unmapped",
      migrationNotes:
        "Map the complete screen contract before exposing this operation from a Cloudflare-hosted operator UI.",
      rollbackNotes:
        "Keep the legacy operator UI hidden until every visible screen dependency is mapped.",
    }))
    .sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
    );
  const routeList = [...routes.values()]
    .map((route) => ({
      ...route,
      sources: route.sources.sort(),
      owner: "lago-operator-ui",
      disposition: "port",
      target: "Cloudflare Workers Static Assets",
      parityStatus: "not-started",
      mappingStatus: "unmapped",
    }))
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
    },
    operationDomains: countBy(operationList, (operation) =>
      operatorDomain(operation.sources[0] ?? "front/src/(unknown)"),
    ),
    operations: operationList,
    routes: routeList,
  };
}

const portRules = [
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
    pattern: /credit_note/i,
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
  const match = portRules.find((rule) => rule.pattern.test(source));
  return match
    ? {
        source,
        owner,
        consumers,
        disposition: "port",
        target: match.target,
        evidence: match.evidence,
        testFixture: match.evidence[0] ?? null,
        parityStatus: "partial",
        migrationNotes: "Port incrementally behind isolated Cloudflare development resources.",
        rollbackNotes: "Keep the legacy Lago path authoritative until parity and cutover approval.",
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
    parityStatusMeaning:
      "partial means at least one behavior has executable evidence; not-started means the source is assigned but has no Cloudflare parity fixture yet",
  },
  summary: {
    models: models.length,
    controllers: controllers.length,
    services: services.length,
    jobs: jobs.length,
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
    jobs: jobs.map(disposition),
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
