import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("BillingAccount idempotency", () => {
  it("replays the same command and rejects conflicting reuse", async () => {
    const stub = env.BILLING_ACCOUNTS.getByName("org-1:customer-1");
    const request = {
      idempotencyKey: "checkout-1",
      commandType: "checkout.create",
      requestHash: "sha256:first",
    };

    const created = await stub.reserveCommand(request);
    expect(created).toMatchObject({ ok: true, replayed: false });

    const replay = await stub.reserveCommand(request);
    expect(replay).toMatchObject({ ok: true, replayed: true });

    await expect(
      stub.reserveCommand({ ...request, requestHash: "sha256:different" }),
    ).resolves.toEqual({
      ok: false,
      error: "idempotency_key_conflict",
    });

    const completed = await stub.completeCommand("checkout-1", {
      checkoutId: "checkout-synthetic",
    });
    expect(completed).toMatchObject({ replayed: false, reservation: { status: "completed" } });
    await expect(stub.getCommand("checkout-1")).resolves.toMatchObject({ status: "completed" });

    const retryable = await stub.reserveCommand({ ...request, idempotencyKey: "checkout-retry" });
    expect(retryable).toMatchObject({ ok: true, replayed: false });
    await expect(stub.releaseCommand("checkout-retry", request.requestHash)).resolves.toEqual({
      ok: true,
      released: true,
    });
    await expect(stub.getCommand("checkout-retry")).resolves.toBeNull();
  });
});
