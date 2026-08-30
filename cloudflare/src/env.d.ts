declare namespace Cloudflare {
  interface Env {
    AUTHORIZE_NET_API_LOGIN_ID?: string;
    AUTHORIZE_NET_TRANSACTION_KEY?: string;
    AUTHORIZE_NET_SIGNATURE_KEY?: string;
    AUTHORIZE_NET_ENVIRONMENT?: "sandbox" | "production";
    AUTHORIZE_NET_SUCCESS_REDIRECT_URL?: string;
    EASY_PAY_DIRECT_COMMERCE_API_KEY?: string;
    EASY_PAY_DIRECT_SECURITY_KEY?: string;
    EASY_PAY_DIRECT_TOKENIZATION_KEY?: string;
    EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET?: string;
    EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY?: string;
    EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY_PREVIOUS?: string;
    EASY_PAY_DIRECT_NETWORK_MODE?: "disabled" | "test" | "gateway_test" | "production";
    EASY_PAY_DIRECT_LIVEMODE_ALLOWED?: "0" | "1";
    EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL?: string;
    EASY_PAY_DIRECT_ACCOUNT_CODE?: string;
    EASY_PAY_DIRECT_ORGANIZATION_ID?: string;
    PUBLIC_BASE_URL?: string;
    CREDIT_NOTE_REFUND_MODE?: "disabled" | "sandbox" | "stripe_test" | "easy_pay_direct_test";
    WALLET_FUNDING_MODE?: "disabled" | "stripe_test";
    EXTERNAL_TAX_MODE?: "disabled" | "service_binding";
    EXTERNAL_TAX_ADAPTER?: Fetcher;
    EASY_PAY_DIRECT_TAX_MODE?: "disabled" | "shadow" | "enforced";
    EASY_PAY_DIRECT_TAX_PROVIDER?: "local_d1" | "stripe_test";
    EASY_PAY_DIRECT_TAX_CODE?: string;
    EASY_PAY_DIRECT_ONE_TIME_TAX_CODE?: string;
    EASY_PAY_DIRECT_TAX_MAX_DATA_AGE_DAYS?: string;
    STRIPE_NETWORK_MODE?: "disabled" | "enabled";
    STRIPE_RESTRICTED_API_KEY?: string;
    STRIPE_WEBHOOKS_ENABLED?: string;
    STRIPE_WEBHOOK_SIGNING_SECRET?: string;
    STRIPE_ACCOUNT_CODE?: string;
    STRIPE_ORGANIZATION_ID?: string;
    STRIPE_LIVEMODE_ALLOWED?: string;
    PAYMENT_MUTATIONS_ENABLED?: string;
    TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
  }
}

interface Env {
  AUTHORIZE_NET_API_LOGIN_ID?: string;
  AUTHORIZE_NET_TRANSACTION_KEY?: string;
  AUTHORIZE_NET_SIGNATURE_KEY?: string;
  AUTHORIZE_NET_ENVIRONMENT?: "sandbox" | "production";
  AUTHORIZE_NET_SUCCESS_REDIRECT_URL?: string;
  EASY_PAY_DIRECT_COMMERCE_API_KEY?: string;
  EASY_PAY_DIRECT_SECURITY_KEY?: string;
  EASY_PAY_DIRECT_TOKENIZATION_KEY?: string;
  EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET?: string;
  EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY?: string;
  EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY_PREVIOUS?: string;
  EASY_PAY_DIRECT_NETWORK_MODE?: "disabled" | "test" | "gateway_test" | "production";
  EASY_PAY_DIRECT_LIVEMODE_ALLOWED?: "0" | "1";
  EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL?: string;
  EASY_PAY_DIRECT_ACCOUNT_CODE?: string;
  EASY_PAY_DIRECT_ORGANIZATION_ID?: string;
  PUBLIC_BASE_URL?: string;
  CREDIT_NOTE_REFUND_MODE?: "disabled" | "sandbox" | "stripe_test" | "easy_pay_direct_test";
  WALLET_FUNDING_MODE?: "disabled" | "stripe_test";
  EXTERNAL_TAX_MODE?: "disabled" | "service_binding";
  EXTERNAL_TAX_ADAPTER?: Fetcher;
  EASY_PAY_DIRECT_TAX_MODE?: "disabled" | "shadow" | "enforced";
  EASY_PAY_DIRECT_TAX_PROVIDER?: "local_d1" | "stripe_test";
  EASY_PAY_DIRECT_TAX_CODE?: string;
  EASY_PAY_DIRECT_ONE_TIME_TAX_CODE?: string;
  EASY_PAY_DIRECT_TAX_MAX_DATA_AGE_DAYS?: string;
  STRIPE_NETWORK_MODE?: "disabled" | "enabled";
  STRIPE_RESTRICTED_API_KEY?: string;
  STRIPE_WEBHOOKS_ENABLED?: string;
  STRIPE_WEBHOOK_SIGNING_SECRET?: string;
  STRIPE_ACCOUNT_CODE?: string;
  STRIPE_ORGANIZATION_ID?: string;
  STRIPE_LIVEMODE_ALLOWED?: string;
  PAYMENT_MUTATIONS_ENABLED?: string;
  PROVIDER_READS_ENABLED?: string;
  TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
}
