import { ApiError } from "../http";

// Gateway's own Payment API / Query API, not Commerce or the NMI v5 API.
// https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#transaction_variables
// Refund transactionid is the ORIGINAL transaction ID. Query actions do not
// document a unique refund-action ID: never infer our refund from a matching sum.
type GatewayEnv = {
  APP_ENV?: string;
  EASY_PAY_DIRECT_NETWORK_MODE?: string;
  EASY_PAY_DIRECT_LIVEMODE_ALLOWED?: string;
  EASY_PAY_DIRECT_SECURITY_KEY?: string;
};
export type GatewayRefundInput = {
  transactionId: string;
  amountMinor: number;
  currency: string;
};
export type GatewayRefundResult = {
  id: string | null;
  status: "succeeded" | "failed" | "unknown";
  responseText: string;
  diagnostic?: string;
};
export type GatewaySaleRefundEvidence = {
  transactionId: string;
  currency: string;
  saleAmountMinor: number;
  refundedAmountMinor: number;
};
const base = "https://secure.easypaydirectgateway.com/api/";
const diagnosticPrefix = "gateway_refund_diagnostic:";
type QueryStructure = {
  transactionCount: number;
  matchingOriginalCount: number;
  truncated: boolean;
  transactions: {
    transactionId: string | null;
    originalTransactionId: string | null;
    currency: string | null;
    condition: string | null;
    relationshipFields: string[];
    actions: { type: string | null; success: string | null; amount: string | null }[];
  }[];
};
class RefundDiagnosticError extends ApiError {
  constructor(
    readonly diagnostic: string,
    readonly structure?: QueryStructure,
  ) {
    super(
      409,
      "easy_pay_direct_gateway_refund_evidence_invalid",
      "Refund evidence requires review.",
    );
  }
}
function queryStructure(rows: RegExpMatchArray[], originalId: string): QueryStructure {
  const value = (xml: string, name: string, allowed: RegExp) => {
    const matches = [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "gu"))];
    const candidate = matches.length === 1 ? matches[0]![1]!.trim() : "";
    return allowed.test(candidate) ? candidate : null;
  };
  const transactions = rows.slice(0, 10).map((row) => {
    const xml = row[1]!;
    const actions = [...xml.matchAll(/<action>([\s\S]*?)<\/action>/gu)];
    const header = xml.replace(/<action>[\s\S]*?<\/action>/gu, "");
    return {
      transactionId: value(header, "transaction_id", /^(?!0+$)[0-9]{1,64}$/u),
      originalTransactionId: value(header, "original_transaction_id", /^(?!0+$)[0-9]{1,64}$/u),
      currency: value(header, "currency", /^[A-Z]{3}$/u),
      condition: value(
        header,
        "condition",
        /^(pending|pendingsettlement|in_progress|abandoned|failed|canceled|complete|unknown)$/u,
      ),
      relationshipFields: [
        "original_transaction_id",
        "parent_transaction_id",
        "related_transaction_id",
        "reference_transaction_id",
        "refunded_transaction_id",
      ].filter((name) => header.includes(`<${name}>`)),
      actions: actions.slice(0, 20).map((action) => ({
        type: value(
          action[1]!,
          "action_type",
          /^(sale|refund|credit|auth|capture|void|return|validate)$/u,
        ),
        success: value(action[1]!, "success", /^[01]$/u),
        amount: value(action[1]!, "amount", /^-?\d{1,12}\.\d{2}$/u),
      })),
    };
  });
  return {
    transactionCount: rows.length,
    matchingOriginalCount: rows.filter(
      (row) =>
        value(
          row[1]!.replace(/<action>[\s\S]*?<\/action>/gu, ""),
          "transaction_id",
          /^(?!0+$)[0-9]{1,64}$/u,
        ) === originalId,
    ).length,
    truncated:
      rows.length > 10 || rows.some((row) => [...row[1]!.matchAll(/<action>/gu)].length > 20),
    transactions,
  };
}
export function gatewayRefundErrorDiagnostic(error: unknown): string {
  return error instanceof RefundDiagnosticError
    ? error.diagnostic
    : `${diagnosticPrefix}operation:checkpoint_or_storage`;
}
const unknown = (diagnostic: string): GatewayRefundResult => ({
  id: null,
  status: "unknown",
  responseText: "Refund outcome needs review; do not resubmit.",
  diagnostic,
});
function invalid(reason = "invalid_evidence"): never {
  throw new RefundDiagnosticError(`${diagnosticPrefix}preflight_query:${reason}`);
}
function identifier(value: string): void {
  if (!/^(?!0+$)[0-9]{1,64}$/u.test(value)) invalid();
}
function network(env: GatewayEnv): { securityKey: string; test: boolean } {
  const test = env.EASY_PAY_DIRECT_NETWORK_MODE === "gateway_test";
  if (
    !(test
      ? ["development", "staging", "test"].includes(env.APP_ENV ?? "") &&
        env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED === "0"
      : env.APP_ENV === "production" &&
        env.EASY_PAY_DIRECT_NETWORK_MODE === "production" &&
        env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED === "1")
  ) {
    throw new ApiError(
      503,
      "easy_pay_direct_gateway_refund_disabled",
      "Refund is disabled for this environment.",
    );
  }
  const securityKey = env.EASY_PAY_DIRECT_SECURITY_KEY?.trim();
  if (!securityKey)
    throw new ApiError(
      503,
      "easy_pay_direct_gateway_key_missing",
      "Gateway credentials are unavailable.",
    );
  return { securityKey, test };
}
async function request(
  path: string,
  body: URLSearchParams,
  fetcher: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let phase: "fetch" | "headers" | "reader" | "decoder" | "read" | "decode" | "finish" = "fetch";
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(`${base}${path}`, {
          method: "POST",
          // Workers rejects redirect:"error" at Request construction. Manual
          // preserves the no-follow boundary; every non-2xx is rejected below.
          redirect: "manual",
          signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        phase = "headers";
        if (
          controller.signal.aborted ||
          !response.body ||
          Number(response.headers.get("content-length")) > 262144
        )
          invalid();
        if (!response.ok)
          throw new RefundDiagnosticError(`${diagnosticPrefix}transport:http_${response.status}`);
        phase = "reader";
        reader = response.body.getReader();
        phase = "decoder";
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        let bytes = 0;
        let raw = "";
        for (;;) {
          phase = "read";
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 262144) invalid();
          phase = "decode";
          raw += decoder.decode(chunk.value, { stream: true });
        }
        phase = "finish";
        return raw + decoder.decode();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RefundDiagnosticError(`${diagnosticPrefix}transport:timeout`));
        }, 15000);
      }),
    ]);
  } catch (error) {
    if (error instanceof RefundDiagnosticError) throw error;
    const allowedNames: Record<string, string> = {
      TypeError: "type_error",
      RangeError: "range_error",
      AbortError: "abort_error",
      InvalidStateError: "invalid_state_error",
      NotSupportedError: "not_supported_error",
      Error: "error",
    };
    const exception = error instanceof Error ? (allowedNames[error.name] ?? "other") : "other";
    throw new RefundDiagnosticError(`${diagnosticPrefix}transport:${phase}:${exception}`);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => undefined);
  }
}
function tag(
  xml: string,
  name:
    | "transaction_id"
    | "original_transaction_id"
    | "currency"
    | "condition"
    | "action_type"
    | "success"
    | "amount",
): string {
  const matches = [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "gu"))];
  if (matches.length !== 1)
    invalid(`tag_${name}_${matches.length === 0 ? "missing" : "duplicate"}`);
  return matches[0]![1]!.trim();
}
function money(value: string): number {
  if (!/^\d+\.\d{2}$/u.test(value)) invalid("amount_format");
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || amount < 0) invalid("amount_range");
  return amount;
}
export async function readEasyPayDirectGatewaySaleRefundEvidence(
  env: GatewayEnv,
  input: Pick<GatewayRefundInput, "transactionId" | "currency">,
  fetcher: typeof fetch = fetch,
): Promise<GatewaySaleRefundEvidence> {
  identifier(input.transactionId);
  const config = network(env);
  let raw: string;
  try {
    raw = await request(
      "query.php",
      new URLSearchParams({
        security_key: config.securityKey,
        transaction_id: input.transactionId,
      }),
      fetcher,
    );
  } catch (error) {
    if (error instanceof RefundDiagnosticError) throw error;
    throw new RefundDiagnosticError(`${diagnosticPrefix}preflight_query:network_or_body`);
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(raw)) invalid("xml_declaration");
  const transactions = [...raw.matchAll(/<transaction>([\s\S]*?)<\/transaction>/gu)];
  if (
    !transactions.length ||
    transactions.length > 100 ||
    [...raw.matchAll(/<transaction>/gu)].length !== transactions.length ||
    [...raw.matchAll(/<\/transaction>/gu)].length !== transactions.length
  )
    throw new RefundDiagnosticError(
      `${diagnosticPrefix}preflight_query:transaction_count`,
      queryStructure(transactions, input.transactionId),
    );
  try {
    const ids = new Set<string>();
    const records = transactions.map((row) => {
      const xml = row[1]!;
      const actions = [...xml.matchAll(/<action>([\s\S]*?)<\/action>/gu)].map(
        (action) => action[1]!,
      );
      if (
        !actions.length ||
        actions.length > 100 ||
        [...xml.matchAll(/<action>/gu)].length !== actions.length ||
        [...xml.matchAll(/<\/action>/gu)].length !== actions.length
      )
        invalid("action_count");
      const header = xml.replace(/<action>[\s\S]*?<\/action>/gu, "");
      const id = tag(header, "transaction_id");
      identifier(id);
      if (ids.has(id)) invalid("duplicate_transaction");
      ids.add(id);
      if (tag(header, "currency") !== input.currency) invalid("currency_mismatch");
      if (!["complete", "pendingsettlement"].includes(tag(header, "condition")))
        invalid("condition");
      for (const action of actions) {
        if (!["0", "1"].includes(tag(action, "success"))) invalid("action_success");
        if (
          !["sale", "refund", "credit", "auth", "capture", "void", "return", "validate"].includes(
            tag(action, "action_type"),
          )
        )
          invalid("action_type");
      }
      return { id, header, actions };
    });
    const originals = records.filter((record) => record.id === input.transactionId);
    if (originals.length !== 1) invalid("transaction_identity");
    const original = originals[0]!;
    if (
      original.header.includes("<original_transaction_id>") &&
      tag(original.header, "original_transaction_id") !== ""
    )
      invalid("original_lineage");
    const actions = original.actions;
    const sales = actions.filter((action) => tag(action, "action_type") === "sale");
    if (sales.length !== 1) invalid("sale_count");
    if (tag(sales[0]!, "success") !== "1") invalid("sale_success");
    let refundedAmountMinor = 0;
    for (const action of actions) {
      const type = tag(action, "action_type");
      const success = tag(action, "success");
      if (success !== "0" && success !== "1") invalid("action_success");
      if (success === "1") {
        if (["void", "credit", "return"].includes(type)) invalid("conflicting_action");
        if (type === "refund") refundedAmountMinor += money(tag(action, "amount"));
      }
    }
    const children = records.filter((record) => record.id !== input.transactionId);
    if (children.length && actions.some((action) => tag(action, "action_type") === "refund"))
      invalid("ambiguous_refund_representation");
    for (const child of children) {
      if (tag(child.header, "original_transaction_id") !== input.transactionId)
        invalid("refund_lineage");
      if (
        child.actions.length !== 1 ||
        tag(child.actions[0]!, "action_type") !== "refund" ||
        tag(child.actions[0]!, "success") !== "1"
      )
        invalid("refund_action");
      const amount = tag(child.actions[0]!, "amount");
      if (!/^-\d+\.\d{2}$/u.test(amount)) invalid("refund_amount_sign");
      const refunded = money(amount.slice(1));
      if (refunded <= 0) invalid("refund_amount_sign");
      refundedAmountMinor += refunded;
    }
    const saleAmountMinor = money(tag(sales[0]!, "amount"));
    if (!Number.isSafeInteger(refundedAmountMinor) || refundedAmountMinor > saleAmountMinor)
      invalid("refund_total_range");
    return {
      transactionId: input.transactionId,
      currency: input.currency,
      saleAmountMinor,
      refundedAmountMinor,
    };
  } catch (error) {
    if (error instanceof RefundDiagnosticError && transactions.length > 1)
      throw new RefundDiagnosticError(
        error.diagnostic,
        queryStructure(transactions, input.transactionId),
      );
    throw error;
  }
}
// Read-only test-account evidence; this helper never submits a refund.
export async function diagnoseEasyPayDirectGatewayRefundEvidence(
  env: GatewayEnv,
  input: Pick<GatewayRefundInput, "transactionId" | "currency">,
  fetcher: typeof fetch = fetch,
): Promise<
  | { status: "verified"; evidence: GatewaySaleRefundEvidence }
  | { status: "unverified"; diagnostic: string; structure?: QueryStructure }
> {
  if (
    env.EASY_PAY_DIRECT_NETWORK_MODE !== "gateway_test" ||
    env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "0" ||
    !["development", "staging", "test"].includes(env.APP_ENV ?? "")
  )
    throw new ApiError(
      503,
      "gateway_refund_diagnostic_disabled",
      "Diagnostic readback is disabled.",
    );
  try {
    return {
      status: "verified",
      evidence: await readEasyPayDirectGatewaySaleRefundEvidence(env, input, fetcher),
    };
  } catch (error) {
    return {
      status: "unverified",
      diagnostic:
        error instanceof RefundDiagnosticError
          ? error.diagnostic
          : `${diagnosticPrefix}preflight_query:invalid_evidence`,
      ...(error instanceof RefundDiagnosticError && error.structure
        ? { structure: error.structure }
        : {}),
    };
  }
}

// Caller MUST durably claim a unique operation before calling. Gateway's
// documented refund API has no idempotency key; never retry unknown submissions.
export async function refundEasyPayDirectGatewayTransaction(
  env: GatewayEnv,
  input: GatewayRefundInput,
  fetcher: typeof fetch,
  checkpoint: (transactionId: string) => Promise<void>,
): Promise<GatewayRefundResult> {
  identifier(input.transactionId);
  if (
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor <= 0 ||
    !/^[A-Z]{3}$/u.test(input.currency)
  )
    invalid();
  const config = network(env);
  try {
    const before = await readEasyPayDirectGatewaySaleRefundEvidence(env, input, fetcher);
    if (input.amountMinor > before.saleAmountMinor - before.refundedAmountMinor) invalid();
  } catch (error) {
    if (
      error instanceof RefundDiagnosticError &&
      error.diagnostic.startsWith(`${diagnosticPrefix}preflight_query:`)
    )
      throw error;
    const reason =
      error instanceof RefundDiagnosticError
        ? error.diagnostic.replace(diagnosticPrefix, "")
        : "invalid_evidence";
    throw new RefundDiagnosticError(`${diagnosticPrefix}preflight_query:${reason}`);
  }
  let raw: string;
  try {
    raw = await request(
      "transact.php",
      new URLSearchParams({
        security_key: config.securityKey,
        type: "refund",
        transactionid: input.transactionId,
        amount: (input.amountMinor / 100).toFixed(2),
        payment: "creditcard",
        ...(config.test ? { test_mode: "enabled" } : {}),
      }),
      fetcher,
    );
  } catch (error) {
    return unknown(
      `${diagnosticPrefix}refund_transport:${error instanceof RefundDiagnosticError ? error.diagnostic.replace(diagnosticPrefix, "") : "network_or_body"}`,
    );
  }
  const result = new URLSearchParams(raw);
  const id = result.get("transactionid");
  const response = result.get("response");
  const code = result.get("response_code");
  if (
    result.getAll("response").length !== 1 ||
    result.getAll("transactionid").length > 1 ||
    result.getAll("response_code").length > 1
  )
    return unknown(`${diagnosticPrefix}refund_response:invalid_fields`);
  if (
    code !== null &&
    (!/^\d{3}$/u.test(code) ||
      (response === "1" && code !== "100") ||
      (response === "2" && !/^2\d{2}$/u.test(code)))
  )
    return unknown(`${diagnosticPrefix}refund_response:contradictory_code`);
  const validId = id !== null && /^(?!0+$)[0-9]{1,64}$/u.test(id);
  if (response === "1" && validId) {
    try {
      await checkpoint(id);
    } catch {
      return unknown(`${diagnosticPrefix}checkpoint:storage`);
    }
    return { id, status: "succeeded", responseText: "Refund approved by Gateway." };
  }
  if (response === "2")
    return { id: null, status: "failed", responseText: "Refund declined by Gateway." };
  const numeric = (key: string) =>
    result.getAll(key).length === 1 && /^\d{1,3}$/u.test(result.get(key) ?? "")
      ? result.get(key)
      : "absent";
  return unknown(
    `${diagnosticPrefix}refund_response:unconfirmed:response_${numeric("response")}:code_${numeric("response_code")}`,
  );
}
