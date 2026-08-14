import { describe, expect, it } from "vitest";
import {
  orderedWalletFeeBuckets,
  projectedUsageByWallet,
  walletAppliesToBucket,
  type WalletApplicability,
  type WalletFeeBucket,
} from "../src/billing/wallet-limitations";

const wallets: WalletApplicability[] = [
  {
    id: "subscription-wallet",
    code: "subscription",
    allowedFeeTypes: new Set(["subscription"]),
    billableMetricIds: new Set(),
  },
  {
    id: "metric-wallet",
    code: "metric",
    allowedFeeTypes: new Set(),
    billableMetricIds: new Set(["metric-events"]),
  },
  {
    id: "unrestricted-wallet",
    code: "unrestricted",
    allowedFeeTypes: new Set(),
    billableMetricIds: new Set(),
  },
];

describe("wallet limitation allocation rules", () => {
  it("matches fee types, metric targets, unrestricted wallets, and explicit overrides", () => {
    expect(walletAppliesToBucket(wallets[0]!, bucket("subscription", 100))).toBe(true);
    expect(walletAppliesToBucket(wallets[0]!, bucket("charge", 100, "metric-events"))).toBe(false);
    expect(walletAppliesToBucket(wallets[1]!, bucket("charge", 100, "metric-events"))).toBe(true);
    expect(walletAppliesToBucket(wallets[2]!, bucket("fixed_charge", 100))).toBe(true);
    expect(
      walletAppliesToBucket(wallets[2]!, {
        ...bucket("fixed_charge", 100),
        targetWalletCode: "metric",
      }),
    ).toBe(false);
    expect(
      walletAppliesToBucket(wallets[1]!, {
        ...bucket("fixed_charge", 100),
        targetWalletCode: "metric",
      }),
    ).toBe(true);
  });

  it("groups largest fee buckets first and assigns each wholly to the top matching wallet", () => {
    const buckets = [
      bucket("subscription", 300),
      bucket("subscription", 200),
      bucket("charge", 600, "metric-events"),
      bucket("fixed_charge", 200),
    ];
    expect(orderedWalletFeeBuckets(buckets)).toEqual([
      bucket("charge", 600, "metric-events"),
      bucket("subscription", 500),
      bucket("fixed_charge", 200),
    ]);
    expect([...projectedUsageByWallet(wallets, buckets, 1300)]).toEqual([
      ["subscription-wallet", 500],
      ["metric-wallet", 600],
      ["unrestricted-wallet", 200],
    ]);
  });

  it("caps projection without using settled wallet balances", () => {
    expect([...projectedUsageByWallet(wallets, [bucket("subscription", 900)], 550)]).toEqual([
      ["subscription-wallet", 550],
      ["metric-wallet", 0],
      ["unrestricted-wallet", 0],
    ]);
  });
});

function bucket(
  feeType: WalletFeeBucket["feeType"],
  amountMinor: number,
  billableMetricId: string | null = null,
): WalletFeeBucket {
  return { feeType, amountMinor, billableMetricId };
}
