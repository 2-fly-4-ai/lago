import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const ORIGIN = "https://serp-dev-lago-epd-serptest.serpcompany.workers.dev";
const DATABASE = "serp-dev-lago-epd-serptest-d1";
const CONFIG = "wrangler.serptest.jsonc";
const ORGANIZATION_ID = "org-epd-serptest-20260909";

const [invoiceId, lineId, itemAmountText, refundAmountText] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
if (!uuid.test(invoiceId ?? "") || !uuid.test(lineId ?? "")) {
  throw new Error(
    "Usage: verify-serptest-refund.mjs <invoice-uuid> <fee-uuid> <item-cents> <refund-cents>",
  );
}
const itemAmount = Number(itemAmountText);
const refundAmount = Number(refundAmountText);
if (
  !Number.isSafeInteger(itemAmount) ||
  itemAmount <= 0 ||
  !Number.isSafeInteger(refundAmount) ||
  refundAmount <= 0
) {
  throw new Error("Amounts must be positive integer cents");
}

const keyId = randomUUID();
const token = `lago_serptest_${randomBytes(32).toString("hex")}`;
const keyHash = createHash("sha256").update(token).digest("hex");
const prefix = token.slice(0, 16);
const ending = token.slice(-4);
const createdAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
const idempotencyKey = `serptest-refund-${randomUUID()}`;

function d1(sql) {
  return execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      DATABASE,
      "--remote",
      "--command",
      sql,
      "--config",
      CONFIG,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function createCreditNote() {
  const response = await fetch(`${ORIGIN}/api/v1/credit_notes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      credit_note: {
        invoice_id: invoiceId,
        reason: "product_unsatisfactory",
        description: "Dedicated SERP TEST Gateway refund verification",
        refund_amount_cents: refundAmount,
        credit_amount_cents: 0,
        offset_amount_cents: 0,
        items: [{ fee_id: lineId, amount_cents: itemAmount }],
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Credit-note request failed (${response.status}): ${body.code ?? body.error ?? "unknown_error"}`,
    );
  }
  return body.credit_note;
}

let first;
try {
  d1(`INSERT INTO api_keys
    (id,organization_id,key_prefix,key_hash,created_at,name,permissions_json,value_ending,expires_at,version,updated_at)
    VALUES('${keyId}','${ORGANIZATION_ID}','${prefix}','${keyHash}','${createdAt}',
      'ephemeral SERP TEST refund verification','{}','${ending}','${expiresAt}',1,'${createdAt}')`);
  first = await createCreditNote();
  const replay = await createCreditNote();
  if (!first?.lago_id || replay?.lago_id !== first.lago_id) {
    throw new Error("Idempotent replay did not return the same credit note");
  }
  console.log(
    JSON.stringify({
      creditNoteId: first.lago_id,
      refundStatus: first.refund_status,
      refundAmountCents: first.refund_amount_cents,
      totalAmountCents: first.total_amount_cents,
      replayedSameCreditNote: true,
    }),
  );
} finally {
  const revokedAt = new Date().toISOString();
  d1(`UPDATE api_keys SET revoked_at='${revokedAt}',updated_at='${revokedAt}',version=version+1
    WHERE id='${keyId}' AND revoked_at IS NULL`);
}
