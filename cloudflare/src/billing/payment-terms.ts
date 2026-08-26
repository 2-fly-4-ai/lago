export function paymentDueDate(issuingAt: string, netPaymentTerm: number): string {
  const issuingDate = new Date(issuingAt);
  if (!Number.isFinite(issuingDate.getTime())) throw new Error("invalid_issuing_timestamp");
  if (!Number.isSafeInteger(netPaymentTerm) || netPaymentTerm < 0)
    throw new Error("invalid_net_payment_term");
  issuingDate.setUTCDate(issuingDate.getUTCDate() + netPaymentTerm);
  return issuingDate.toISOString().slice(0, 10);
}
