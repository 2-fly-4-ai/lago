import { createPublicKey, verify } from "node:crypto";
import { validateRuleSetArtifact } from "./indirect-tax-rule-set.mjs";
import { renderCanadianDraftSql } from "./canada-software-candidate.mjs";

const FORMAT = "serp-signed-tax-artifact/v1";
const date = (v) =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

export function taxSignaturePayload(artifact, envelope) {
  const checked = validateRuleSetArtifact(artifact);
  return Buffer.from(
    JSON.stringify([
      FORMAT,
      envelope.key_id,
      envelope.environment,
      envelope.organization_id,
      envelope.issued_at,
      envelope.expires_at,
      checked.id,
      checked.version,
      checked.content_sha256,
    ]),
  );
}

// Trust is supplied independently by the deploy operator, never by the downloaded artifact.
// This verifies a publication; it does not create a collection scope or activate any rules.
export function verifySignedTaxArtifact(artifact, envelope, policy) {
  const checked = validateRuleSetArtifact(artifact);
  const keys = [
    "format",
    "key_id",
    "environment",
    "organization_id",
    "issued_at",
    "expires_at",
    "signature",
  ];
  if (
    !envelope ||
    Object.keys(envelope).sort().join() !== keys.sort().join() ||
    envelope.format !== FORMAT ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(envelope.key_id) ||
    !["staging", "production"].includes(envelope.environment) ||
    typeof envelope.organization_id !== "string" ||
    !envelope.organization_id.length ||
    !date(envelope.issued_at) ||
    !date(envelope.expires_at) ||
    !date(policy.now) ||
    envelope.environment !== policy.environment ||
    envelope.organization_id !== policy.organization_id
  )
    throw new Error("Invalid signature envelope or target");
  const now = Date.parse(policy.now);
  const issued = Date.parse(envelope.issued_at);
  const expires = Date.parse(envelope.expires_at);
  if (issued > now || expires <= now || expires <= issued || expires - issued > 30 * 86400000)
    throw new Error("Signature publication is expired or future dated");
  if (
    !Number.isSafeInteger(policy.minimum_version) ||
    policy.minimum_version < 1 ||
    checked.version < policy.minimum_version
  )
    throw new Error("Artifact rollback rejected");
  if (
    !Number.isSafeInteger(policy.max_source_age_days) ||
    policy.max_source_age_days < 1 ||
    policy.max_source_age_days > 30
  )
    throw new Error("Invalid freshness policy");
  for (const timestamp of [
    checked.refreshed_at,
    ...checked.source.components.map((c) => c.retrieved_at),
  ]) {
    const age = now - Date.parse(timestamp);
    if (age < 0 || age > policy.max_source_age_days * 86400000)
      throw new Error("Stale or future source evidence");
  }
  const trusted = policy.keys?.filter((k) => k.key_id === envelope.key_id && k.revoked !== true);
  if (trusted?.length !== 1) throw new Error("Signing key is not uniquely trusted");
  const key = createPublicKey(trusted[0].public_key_pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Only Ed25519 publication keys are supported");
  if (typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature))
    throw new Error("Invalid signature encoding");
  const signature = Buffer.from(envelope.signature, "base64url");
  if (
    signature.toString("base64url") !== envelope.signature ||
    !verify(null, taxSignaturePayload(checked, envelope), key, signature)
  )
    throw new Error("Invalid artifact signature");
  return checked;
}

export function renderSignedTaxDraft(artifact, envelope, policy) {
  const checked = verifySignedTaxArtifact(artifact, envelope, policy);
  if (!Object.hasOwn(policy, "previous_artifact"))
    throw new Error("Previous artifact must be supplied, or explicitly null for a first import");
  if (policy.previous_artifact !== null) {
    const previous = validateRuleSetArtifact(policy.previous_artifact);
    const matchKey = (rule) =>
      JSON.stringify([
        rule.country,
        rule.region,
        rule.postal_prefix,
        rule.product_tax_code,
        rule.priority,
      ]);
    const next = new Set(checked.rules.map(matchKey));
    if (previous.rules.some((rule) => !next.has(matchKey(rule))))
      throw new Error("Candidate would drop existing jurisdiction coverage");
    if (checked.version <= previous.version && checked.content_sha256 !== previous.content_sha256)
      throw new Error("Changed publication must advance the version");
  }
  return renderCanadianDraftSql(checked, policy.now);
}
