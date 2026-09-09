import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/http";
import {
  pendingProviderReceipts,
  quarantinedEasyPayDirectReceiptCount,
  reconcileEasyPayDirectReceiptSafely,
} from "../src/reconciliation/easy-pay-direct-receipt-safety";

async function receiptFixture(archive = true, errorCode: string | null = null) {
  const id = `receipt-safety-${crypto.randomUUID()}`;
  const organizationId = `receipt-org-${id}`;
  const archiveKey = `fixtures/${id}.json`;
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({
    id,
    type: "customer.created",
    livemode: false,
    data: { object: { id: "fictional-object" } },
  });
  if (archive) await env.BILLING_ARTIFACTS.put(archiveKey, body);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`INSERT INTO organizations
      (id, external_id, name, created_at, updated_at) VALUES (?, ?, 'Receipt QA', ?, ?)`).bind(
      organizationId,
      organizationId,
      timestamp,
      timestamp,
    ),
    env.BILLING_DB.prepare(`INSERT INTO webhook_receipts
      (id, provider, provider_account_code, provider_event_id, signature_valid, payload_sha256,
       received_at, processed_at, processing_error_code, archive_key)
      VALUES (?, 'easy_pay_direct', 'receipt-safety-test', ?, 1, 'fixture-hash', ?, NULL, ?, ?)`).bind(
      id,
      id,
      timestamp,
      errorCode,
      archiveKey,
    ),
    env.BILLING_DB.prepare(`INSERT INTO provider_webhook_events
      (receipt_id, organization_id, event_type, provider_transaction_id, invoice_id, normalized_status, normalized_at)
      VALUES (?, ?, 'customer.created', 'fictional-object', NULL, NULL, NULL)`).bind(
      id,
      organizationId,
    ),
  ]);
  return { id, archiveKey, body };
}

describe("EPD receipt quarantine boundaries", () => {
  it("reserves EPD capacity when 100 older Authorize.Net receipts remain deferred", async () => {
    const prefix = `provider-fairness-${crypto.randomUUID()}`;
    await env.BILLING_DB.batch(
      Array.from({ length: 100 }, (_, index) => {
        const id = `${prefix}-${index}`;
        return env.BILLING_DB.prepare(`INSERT INTO webhook_receipts
          (id, provider, provider_account_code, provider_event_id, signature_valid, payload_sha256,
           received_at, processed_at, processing_error_code)
          VALUES (?, 'authorize_net', 'receipt-safety-test', ?, 1, 'fixture-hash',
            '2000-01-01T00:00:00.000Z', NULL, NULL)`).bind(id, id);
      }),
    );
    const next = await receiptFixture();
    const candidates = await pendingProviderReceipts(env.BILLING_DB);
    expect(candidates.filter((receipt) => receipt.provider === "authorize_net")).toHaveLength(50);
    expect(
      candidates.filter((receipt) => receipt.provider === "easy_pay_direct").length,
    ).toBeLessThanOrEqual(50);
    expect(candidates.map((receipt) => receipt.id)).toContain(next.id);
    expect(candidates.length).toBeLessThanOrEqual(100);
  });

  it("isolates a missing archive and continues to the next receipt", async () => {
    const missing = await receiptFixture(false);
    const next = await receiptFixture();
    const outcomes = [];
    for (const receipt of [missing, next])
      outcomes.push(await reconcileEasyPayDirectReceiptSafely(env, receipt.id));
    expect(outcomes).toEqual(["quarantined", "processed"]);
    expect(
      await env.BILLING_DB.prepare(
        "SELECT processed_at, processing_error_code FROM webhook_receipts WHERE id = ?",
      )
        .bind(missing.id)
        .first(),
    ).toMatchObject({
      processed_at: null,
      processing_error_code: "epd_receipt_review:easy_pay_direct_webhook_archive_missing",
    });
    expect(await quarantinedEasyPayDirectReceiptCount(env.BILLING_DB)).toBeGreaterThan(0);
  });

  it("preserves financial mismatch evidence and does not rerun a quarantined receipt", async () => {
    const receipt = await receiptFixture();
    const reconcile = vi.fn(async (): Promise<"processed"> => {
      throw new ApiError(409, "easy_pay_direct_order_evidence_mismatch", "Review payment evidence");
    });
    expect(await reconcileEasyPayDirectReceiptSafely(env, receipt.id, reconcile)).toBe(
      "quarantined",
    );
    expect(await reconcileEasyPayDirectReceiptSafely(env, receipt.id, reconcile)).toBe(
      "quarantined",
    );
    expect(reconcile).toHaveBeenCalledOnce();
    expect(await (await env.BILLING_ARTIFACTS.get(receipt.archiveKey))?.text()).toBe(receipt.body);
  });

  it.each([
    new Error("D1 unavailable"),
    new TypeError("unexpected programming error"),
    new ApiError(503, "provider_unavailable", "Transient provider failure"),
  ])("does not swallow infrastructure or unclassified errors: %s", async (failure) => {
    const receipt = await receiptFixture();
    await expect(
      reconcileEasyPayDirectReceiptSafely(env, receipt.id, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(
      await env.BILLING_DB.prepare(
        "SELECT processing_error_code FROM webhook_receipts WHERE id = ?",
      )
        .bind(receipt.id)
        .first(),
    ).toMatchObject({ processing_error_code: null });
  });

  it("excludes more than 100 quarantined receipts before candidate limiting", async () => {
    const prefix = `quarantine-limit-${crypto.randomUUID()}`;
    await env.BILLING_DB.batch(
      Array.from({ length: 101 }, (_, index) => {
        const id = `${prefix}-${index}`;
        return env.BILLING_DB.prepare(`INSERT INTO webhook_receipts
        (id, provider, provider_account_code, provider_event_id, signature_valid, payload_sha256,
         received_at, processed_at, processing_error_code)
        VALUES (?, 'easy_pay_direct', 'receipt-safety-test', ?, 1, 'fixture-hash',
          '2000-01-01T00:00:00.000Z', NULL, 'epd_receipt_review:payment_request_not_found')`).bind(
          id,
          id,
        );
      }),
    );
    const next = await receiptFixture();
    expect((await pendingProviderReceipts(env.BILLING_DB)).map((receipt) => receipt.id)).toContain(
      next.id,
    );
    expect(
      (await pendingProviderReceipts(env.BILLING_DB)).some((receipt) =>
        receipt.id.startsWith(prefix),
      ),
    ).toBe(false);
  });
});
