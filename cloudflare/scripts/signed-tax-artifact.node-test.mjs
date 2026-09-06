import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { contentChecksum } from "./indirect-tax-rule-set.mjs";
import {
  taxSignaturePayload,
  verifySignedTaxArtifact,
  renderSignedTaxDraft,
} from "./signed-tax-artifact.mjs";
const artifact = JSON.parse(
  await readFile(
    new URL("../fixtures/indirect-tax/candidate-2026-08-31.json", import.meta.url),
    "utf8",
  ),
);
// Ephemeral test keys never touch disk or any provider/account.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const envelope = {
  format: "serp-signed-tax-artifact/v1",
  key_id: "test-publisher",
  environment: "staging",
  organization_id: "test-organization",
  issued_at: "2026-09-05T00:00:00.000Z",
  expires_at: "2026-09-12T00:00:00.000Z",
};
envelope.signature = sign(null, taxSignaturePayload(artifact, envelope), privateKey).toString(
  "base64url",
);
const policy = {
  previous_artifact: null,
  now: "2026-09-05T12:00:00.000Z",
  environment: "staging",
  organization_id: "test-organization",
  minimum_version: 1,
  max_source_age_days: 30,
  keys: [
    { key_id: "test-publisher", public_key_pem: publicKey.export({ type: "spki", format: "pem" }) },
  ],
};

test("valid signed publication renders only a draft", () => {
  assert.equal(verifySignedTaxArtifact(artifact, envelope, policy).id, artifact.id);
  const sql = renderSignedTaxDraft(artifact, envelope, policy);
  assert.match(sql, /draft/);
  assert.doesNotMatch(sql, /INSERT INTO indirect_tax_registration_scopes|SET status = 'active'/);
});

test("rejects tampered data even when attacker recalculates the checksum", () => {
  const bad = structuredClone(artifact);
  bad.rules[0].rate_ppm++;
  bad.content_sha256 = contentChecksum(bad);
  assert.throws(() => verifySignedTaxArtifact(bad, envelope, policy));
});

test("signed draft refuses missing baseline or dropped geographic coverage", () => {
  const absent = { ...policy };
  delete absent.previous_artifact;
  assert.throws(() => renderSignedTaxDraft(artifact, envelope, absent), /Previous artifact/);
  const previous = structuredClone(artifact);
  previous.rules.push({
    ...previous.rules[0],
    id: "previous-additional-rule",
    country: "US",
    region: "CT",
  });
  previous.content_sha256 = contentChecksum(previous);
  assert.throws(
    () => renderSignedTaxDraft(artifact, envelope, { ...policy, previous_artifact: previous }),
    /drop existing/,
  );
  assert.doesNotThrow(() =>
    renderSignedTaxDraft(artifact, envelope, { ...policy, previous_artifact: artifact }),
  );
});

test("rejects wrong targets, expired signatures, rollback and revoked keys", () => {
  for (const patch of [
    { environment: "production" },
    { organization_id: "other" },
    { now: "2026-09-13T00:00:00.000Z" },
    { now: "2026-09-04T00:00:00.000Z" },
    { minimum_version: artifact.version + 1 },
    { keys: [] },
    { keys: [{ ...policy.keys[0], revoked: true }] },
    { keys: [policy.keys[0], policy.keys[0]] },
    { max_source_age_days: 1 },
  ])
    assert.throws(() => verifySignedTaxArtifact(artifact, envelope, { ...policy, ...patch }));
  assert.throws(() => verifySignedTaxArtifact(artifact, { ...envelope, signature: "x" }, policy));
  assert.throws(() =>
    verifySignedTaxArtifact(
      artifact,
      { ...envelope, public_key: policy.keys[0].public_key_pem },
      policy,
    ),
  );
});
