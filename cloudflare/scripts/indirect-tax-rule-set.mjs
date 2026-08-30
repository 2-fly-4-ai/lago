import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FORMAT = "serp-indirect-tax-rule-set/v1";
const TAX_CODE = /^txcd_\d{8}$/;
const COUNTRY = /^[A-Z]{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function parseRuleSetArtifact(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateRuleSetArtifact(value);
}

export function validateRuleSetArtifact(value) {
  const artifact = object(value, "artifact");
  exactKeys(
    artifact,
    [
      "format",
      "id",
      "version",
      "status",
      "source",
      "effective_from",
      "effective_to",
      "refreshed_at",
      "content_sha256",
      "rules",
    ],
    "artifact",
  );
  equal(artifact.format, FORMAT, "artifact.format");
  identifier(artifact.id, "artifact.id");
  integer(artifact.version, "artifact.version", 1, Number.MAX_SAFE_INTEGER);
  equal(artifact.status, "draft", "artifact.status");
  isoDateTime(artifact.effective_from, "artifact.effective_from");
  nullableIsoDateTime(artifact.effective_to, "artifact.effective_to");
  isoDateTime(artifact.refreshed_at, "artifact.refreshed_at");
  if (
    artifact.effective_to !== null &&
    Date.parse(artifact.effective_to) <= Date.parse(artifact.effective_from)
  ) {
    fail("artifact.effective_to must be after artifact.effective_from");
  }

  const source = object(artifact.source, "artifact.source");
  exactKeys(source, ["name", "url", "published_at", "components"], "artifact.source");
  boundedString(source.name, "artifact.source.name", 1, 200);
  sourceReference(source.url, "artifact.source.url");
  isoDateTime(source.published_at, "artifact.source.published_at");
  array(source.components, "artifact.source.components", 1);
  const sourceIds = new Set();
  for (const [index, item] of source.components.entries()) {
    const component = object(item, `artifact.source.components[${index}]`);
    exactKeys(component, ["id", "authority", "url", "retrieved_at"], `source component ${index}`);
    identifier(component.id, `source component ${index}.id`);
    unique(sourceIds, component.id, `duplicate source component id ${component.id}`);
    boundedString(component.authority, `source component ${index}.authority`, 1, 200);
    httpsUrl(component.url, `source component ${index}.url`);
    isoDateTime(component.retrieved_at, `source component ${index}.retrieved_at`);
  }

  boundedString(artifact.content_sha256, "artifact.content_sha256", 64, 64);
  if (!SHA256.test(artifact.content_sha256))
    fail("artifact.content_sha256 must be lowercase SHA-256");
  array(artifact.rules, "artifact.rules", 1);
  const rules = [];
  const ruleIds = new Set();
  const matchKeys = new Set();
  for (const [index, item] of artifact.rules.entries()) {
    const path = `artifact.rules[${index}]`;
    const rule = object(item, path);
    exactKeys(
      rule,
      [
        "id",
        "country",
        "region",
        "postal_prefix",
        "product_tax_code",
        "taxability",
        "rate_ppm",
        "priority",
        "source_component_id",
        "source_url",
        "source_reference",
        "effective_from",
        "effective_to",
      ],
      path,
    );
    identifier(rule.id, `${path}.id`);
    unique(ruleIds, rule.id, `duplicate rule id ${rule.id}`);
    boundedString(rule.country, `${path}.country`, 2, 2);
    if (!COUNTRY.test(rule.country)) fail(`${path}.country must be ISO alpha-2 uppercase`);
    nullableUpperString(rule.region, `${path}.region`, 1, 100);
    nullableUpperString(rule.postal_prefix, `${path}.postal_prefix`, 1, 20);
    boundedString(rule.product_tax_code, `${path}.product_tax_code`, 13, 13);
    if (!TAX_CODE.test(rule.product_tax_code)) fail(`${path}.product_tax_code is invalid`);
    if (!new Set(["taxable", "exempt"]).has(rule.taxability)) {
      fail(`${path}.taxability must be taxable or exempt`);
    }
    integer(rule.rate_ppm, `${path}.rate_ppm`, 0, 1_000_000);
    if (rule.taxability === "exempt" && rule.rate_ppm !== 0) {
      fail(`${path}.rate_ppm must be zero for an exemption`);
    }
    integer(rule.priority, `${path}.priority`, 0, 1000);
    identifier(rule.source_component_id, `${path}.source_component_id`);
    if (!sourceIds.has(rule.source_component_id)) {
      fail(`${path}.source_component_id does not identify an artifact source component`);
    }
    httpsUrl(rule.source_url, `${path}.source_url`);
    boundedString(rule.source_reference, `${path}.source_reference`, 1, 1000);
    isoDateTime(rule.effective_from, `${path}.effective_from`);
    nullableIsoDateTime(rule.effective_to, `${path}.effective_to`);
    if (
      rule.effective_to !== null &&
      Date.parse(rule.effective_to) <= Date.parse(rule.effective_from)
    ) {
      fail(`${path}.effective_to must be after effective_from`);
    }
    const matchKey = [
      rule.country,
      rule.region ?? "",
      rule.postal_prefix ?? "",
      rule.product_tax_code,
      rule.priority,
    ].join("|");
    unique(matchKeys, matchKey, `${path} duplicates a rule match key`);
    rules.push({ ...rule });
  }

  const normalized = {
    format: artifact.format,
    id: artifact.id,
    version: artifact.version,
    status: artifact.status,
    source: {
      name: source.name,
      url: source.url,
      published_at: source.published_at,
      components: [...source.components].map((item) => ({ ...item })).sort(byId),
    },
    effective_from: artifact.effective_from,
    effective_to: artifact.effective_to,
    refreshed_at: artifact.refreshed_at,
    content_sha256: artifact.content_sha256,
    rules: rules.sort(byId),
  };
  const actualChecksum = contentChecksum(normalized);
  if (actualChecksum !== normalized.content_sha256) {
    fail(
      `artifact.content_sha256 mismatch: expected ${actualChecksum}, received ${normalized.content_sha256}`,
    );
  }
  return normalized;
}

export function contentChecksum(artifact) {
  const payload = structuredClone(artifact);
  delete payload.content_sha256;
  if (payload.source?.components) payload.source.components.sort(byId);
  if (payload.rules) payload.rules.sort(byId);
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function renderDraftSql(artifact, createdAt) {
  const normalized = validateRuleSetArtifact(artifact);
  isoDateTime(createdAt, "createdAt");
  const statements = [
    "-- Generated from a validated, checksummed candidate artifact.",
    "-- This intentionally creates a draft only. It never activates a rule set or adds registrations.",
    "BEGIN TRANSACTION;",
    `INSERT INTO indirect_tax_rule_sets\n  (id, version, status, source_name, source_url, source_published_at, effective_from,\n   effective_to, content_sha256, refreshed_at, created_at, activated_at)\nVALUES\n  (${sql(normalized.id)}, ${normalized.version}, 'draft', ${sql(normalized.source.name)}, ${sql(normalized.source.url)},\n   ${sql(normalized.source.published_at)}, ${sql(normalized.effective_from)}, ${sql(normalized.effective_to)},\n   ${sql(normalized.content_sha256)}, ${sql(normalized.refreshed_at)}, ${sql(createdAt)}, NULL);`,
  ];
  for (const rule of normalized.rules) {
    statements.push(
      `INSERT INTO indirect_tax_rules\n  (id, rule_set_id, country, region, postal_prefix, product_tax_code, taxability,\n   rate_ppm, priority, source_url, source_reference, effective_from, effective_to, created_at)\nVALUES\n  (${sql(rule.id)}, ${sql(normalized.id)}, ${sql(rule.country)}, ${sql(rule.region)},\n   ${sql(rule.postal_prefix)}, ${sql(rule.product_tax_code)}, ${sql(rule.taxability)},\n   ${rule.rate_ppm}, ${rule.priority}, ${sql(rule.source_url)}, ${sql(rule.source_reference)},\n   ${sql(rule.effective_from)}, ${sql(rule.effective_to)}, ${sql(createdAt)});`,
    );
  }
  statements.push("COMMIT;");
  return `${statements.join("\n\n")}\n`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sql(value) {
  if (value === null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function byId(left, right) {
  return left.id.localeCompare(right.id);
}

function exactKeys(value, keys, path) {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${path} keys must be exactly: ${expected.join(", ")}`);
  }
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value;
}

function array(value, path, minimumLength) {
  if (!Array.isArray(value) || value.length < minimumLength) {
    fail(`${path} must contain at least ${minimumLength} item(s)`);
  }
}

function boundedString(value, path, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    fail(`${path} must be a string between ${minimum} and ${maximum} characters`);
  }
}

function identifier(value, path) {
  boundedString(value, path, 1, 120);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) fail(`${path} must be a lowercase identifier`);
}

function integer(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${path} must be an integer between ${minimum} and ${maximum}`);
  }
}

function equal(value, expected, path) {
  if (value !== expected) fail(`${path} must equal ${expected}`);
}

function nullableUpperString(value, path, minimum, maximum) {
  if (value === null) return;
  boundedString(value, path, minimum, maximum);
  if (value !== value.toUpperCase()) fail(`${path} must be uppercase`);
}

function isoDateTime(value, path) {
  boundedString(value, path, 20, 30);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${path} must be a canonical UTC ISO timestamp`);
  }
}

function nullableIsoDateTime(value, path) {
  if (value !== null) isoDateTime(value, path);
}

function httpsUrl(value, path) {
  boundedString(value, path, 1, 2048);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${path} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") fail(`${path} must use HTTPS`);
}

function sourceReference(value, path) {
  boundedString(value, path, 1, 2048);
  if (value.startsWith("docs/")) return;
  httpsUrl(value, path);
}

function unique(seen, value, message) {
  if (seen.has(value)) fail(message);
  seen.add(value);
}

function fail(message) {
  throw new Error(message);
}

async function main() {
  const [command, artifactPath, ...rest] = process.argv.slice(2);
  if (!new Set(["validate", "checksum", "render-sql"]).has(command) || !artifactPath) {
    throw new Error(
      "Usage: indirect-tax-rule-set.mjs <validate|checksum|render-sql> <artifact.json> [--created-at ISO]",
    );
  }
  const raw = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (command === "checksum") {
    process.stdout.write(`${contentChecksum(raw)}\n`);
    return;
  }
  const artifact = validateRuleSetArtifact(raw);
  if (command === "validate") {
    process.stdout.write(
      `${JSON.stringify({ id: artifact.id, version: artifact.version, rules: artifact.rules.length, checksum: artifact.content_sha256 })}\n`,
    );
    return;
  }
  const createdAtIndex = rest.indexOf("--created-at");
  if (createdAtIndex < 0 || !rest[createdAtIndex + 1]) {
    throw new Error("render-sql requires --created-at with a canonical UTC ISO timestamp");
  }
  process.stdout.write(renderDraftSql(artifact, rest[createdAtIndex + 1]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
