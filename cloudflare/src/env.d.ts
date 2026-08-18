declare namespace Cloudflare {
  interface Env {
    AUTHORIZE_NET_API_LOGIN_ID?: string;
    AUTHORIZE_NET_TRANSACTION_KEY?: string;
    AUTHORIZE_NET_SIGNATURE_KEY?: string;
    AUTHORIZE_NET_ENVIRONMENT?: "sandbox" | "production";
    AUTHORIZE_NET_SUCCESS_REDIRECT_URL?: string;
    PUBLIC_BASE_URL?: string;
    CREDIT_NOTE_REFUND_MODE?: "disabled" | "sandbox";
    STRIPE_NETWORK_MODE?: "disabled" | "enabled";
    STRIPE_RESTRICTED_API_KEY?: string;
    STRIPE_WEBHOOKS_ENABLED?: string;
    STRIPE_WEBHOOK_SIGNING_SECRET?: string;
    STRIPE_ACCOUNT_CODE?: string;
    STRIPE_ORGANIZATION_ID?: string;
    STRIPE_LIVEMODE_ALLOWED?: string;
    TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
  }
}

interface Env {
  AUTHORIZE_NET_API_LOGIN_ID?: string;
  AUTHORIZE_NET_TRANSACTION_KEY?: string;
  AUTHORIZE_NET_SIGNATURE_KEY?: string;
  AUTHORIZE_NET_ENVIRONMENT?: "sandbox" | "production";
  AUTHORIZE_NET_SUCCESS_REDIRECT_URL?: string;
  PUBLIC_BASE_URL?: string;
  CREDIT_NOTE_REFUND_MODE?: "disabled" | "sandbox";
  STRIPE_NETWORK_MODE?: "disabled" | "enabled";
  STRIPE_RESTRICTED_API_KEY?: string;
  STRIPE_WEBHOOKS_ENABLED?: string;
  STRIPE_WEBHOOK_SIGNING_SECRET?: string;
  STRIPE_ACCOUNT_CODE?: string;
  STRIPE_ORGANIZATION_ID?: string;
  STRIPE_LIVEMODE_ALLOWED?: string;
  PROVIDER_READS_ENABLED?: string;
  TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
}
