export const WALLET_FEE_TYPES = [
  "charge",
  "add_on",
  "subscription",
  "credit",
  "commitment",
  "fixed_charge",
] as const;

export type WalletFeeType = (typeof WALLET_FEE_TYPES)[number];

export type WalletFeeBucket = {
  amountMinor: number;
  billableMetricId: string | null;
  feeType: WalletFeeType;
  targetWalletCode?: string | null;
};

export type WalletApplicability = {
  id: string;
  code: string;
  allowedFeeTypes: ReadonlySet<WalletFeeType>;
  billableMetricIds: ReadonlySet<string>;
};

export function walletAppliesToBucket(
  wallet: WalletApplicability,
  bucket: WalletFeeBucket,
): boolean {
  if (bucket.targetWalletCode) return wallet.code === bucket.targetWalletCode;
  const metricMatch =
    bucket.feeType === "charge" &&
    bucket.billableMetricId !== null &&
    wallet.billableMetricIds.has(bucket.billableMetricId);
  const typeMatch = wallet.allowedFeeTypes.has(bucket.feeType);
  const unrestricted = wallet.allowedFeeTypes.size === 0 && wallet.billableMetricIds.size === 0;
  return metricMatch || typeMatch || unrestricted;
}

export function projectedUsageByWallet(
  wallets: WalletApplicability[],
  buckets: WalletFeeBucket[],
  maximumMinor: number,
): Map<string, number> {
  if (!Number.isSafeInteger(maximumMinor) || maximumMinor < 0)
    throw new Error("invalid_wallet_projection_cap");
  const result = new Map(wallets.map((wallet) => [wallet.id, 0]));
  let remaining = maximumMinor;
  for (const bucket of orderedWalletFeeBuckets(buckets)) {
    if (remaining <= 0) break;
    const wallet = wallets.find((candidate) => walletAppliesToBucket(candidate, bucket));
    if (!wallet) continue;
    const amountMinor = Math.min(bucket.amountMinor, remaining);
    result.set(wallet.id, safeAdd(result.get(wallet.id) ?? 0, amountMinor));
    remaining -= amountMinor;
  }
  return result;
}

export function orderedWalletFeeBuckets(buckets: WalletFeeBucket[]): WalletFeeBucket[] {
  const grouped = new Map<string, WalletFeeBucket>();
  for (const bucket of buckets) {
    if (!Number.isSafeInteger(bucket.amountMinor) || bucket.amountMinor < 0)
      throw new Error("invalid_wallet_fee_bucket");
    if (bucket.amountMinor === 0) continue;
    const key = JSON.stringify([
      bucket.feeType,
      bucket.billableMetricId,
      bucket.targetWalletCode ?? null,
    ]);
    const current = grouped.get(key);
    grouped.set(key, {
      ...bucket,
      amountMinor: safeAdd(current?.amountMinor ?? 0, bucket.amountMinor),
    });
  }
  return [...grouped.values()].sort((left, right) => {
    if (left.amountMinor !== right.amountMinor) return right.amountMinor - left.amountMinor;
    return bucketKey(left).localeCompare(bucketKey(right));
  });
}

function bucketKey(bucket: WalletFeeBucket): string {
  return `${bucket.feeType}:${bucket.billableMetricId ?? ""}:${bucket.targetWalletCode ?? ""}`;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("invalid_wallet_fee_total");
  return total;
}
