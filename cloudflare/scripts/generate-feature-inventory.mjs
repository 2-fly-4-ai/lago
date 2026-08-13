import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

const portRules = [
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
        disposition: "unknown",
        target: null,
        evidence: [],
        testFixture: null,
        parityStatus: "not-assessed",
        migrationNotes: "Usage and required disposition are not yet proven.",
        rollbackNotes: "Do not retire or reroute this feature without evidence and approval.",
      };
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
    apiRevision: gitRevision(apiDirectory),
    frontRevision: gitRevision(frontDirectory),
  },
  policy: {
    allowedDispositions: ["port", "retire", "external", "blocked", "not-used", "unknown"],
    defaultDisposition: "unknown",
    retirementRequiresApproval: true,
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
