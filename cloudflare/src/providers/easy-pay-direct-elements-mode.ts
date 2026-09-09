import { ApiError } from "../http";

export type EasyPayDirectElementsModeEnv = {
  APP_ENV?: string;
  EASY_PAY_DIRECT_NETWORK_MODE?: "disabled" | "test" | "gateway_test" | "production";
  EASY_PAY_DIRECT_LIVEMODE_ALLOWED?: "0" | "1";
};

export type EasyPayDirectElementsMode = {
  mode: "sandbox" | "live";
  sandbox: boolean;
};

function configurationMismatch(): never {
  throw new ApiError(
    503,
    "easy_pay_direct_elements_environment_mismatch",
    "Secure payment fields are not configured for this environment.",
  );
}

export function requireEasyPayDirectElementsMode(
  env: EasyPayDirectElementsModeEnv,
): EasyPayDirectElementsMode {
  const appEnvironment = env.APP_ENV ?? "";
  const networkMode = env.EASY_PAY_DIRECT_NETWORK_MODE ?? "disabled";
  const liveAllowed = env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED;
  if (
    ["development", "staging", "test"].includes(appEnvironment) &&
    ["test", "gateway_test"].includes(networkMode) &&
    liveAllowed === "0"
  ) {
    return { mode: "sandbox", sandbox: true };
  }
  if (appEnvironment === "production" && networkMode === "production" && liveAllowed === "1") {
    return { mode: "live", sandbox: false };
  }
  return configurationMismatch();
}

function legacyCommerceKeyMatchesMode(key: string, mode: "test" | "live"): boolean {
  const match = key.match(/^epd_[A-Za-z0-9]+_[A-Za-z0-9]+_(test|live)_[A-Za-z0-9]+$/u);
  return match?.[1] === mode;
}

export function requireEasyPayDirectElementsSecretKey(
  env: EasyPayDirectElementsModeEnv,
  rawKey: string | undefined,
): string {
  const runtime = requireEasyPayDirectElementsMode(env);
  const key = rawKey?.trim() ?? "";
  const standardKey =
    runtime.mode === "sandbox"
      ? /^epd_(?:test_sk|restricted_sk_test)_[A-Za-z0-9]+$/u.test(key)
      : /^epd_(?:live_sk|restricted_sk_live)_[A-Za-z0-9]+$/u.test(key);
  if (
    !standardKey &&
    !legacyCommerceKeyMatchesMode(key, runtime.mode === "sandbox" ? "test" : "live")
  ) {
    throw new ApiError(
      503,
      "easy_pay_direct_key_environment_mismatch",
      "The payment API key does not match this environment.",
    );
  }
  return key;
}

export function requireEasyPayDirectElementsPublishableKey(
  env: EasyPayDirectElementsModeEnv,
  rawKey: string | undefined,
): string {
  const runtime = requireEasyPayDirectElementsMode(env);
  const key = rawKey?.trim() ?? "";
  const matches =
    runtime.mode === "sandbox"
      ? /^epd_test_pk_[A-Za-z0-9]+$/u.test(key)
      : /^epd_live_pk_[A-Za-z0-9]+$/u.test(key);
  if (!matches) {
    throw new ApiError(
      503,
      "easy_pay_direct_elements_publishable_key_required",
      "Secure payment fields are not configured.",
    );
  }
  return key;
}
