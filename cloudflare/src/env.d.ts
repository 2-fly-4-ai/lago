declare namespace Cloudflare {
  interface Env {
    AUTHORIZE_NET_API_LOGIN_ID?: string;
    AUTHORIZE_NET_TRANSACTION_KEY?: string;
    AUTHORIZE_NET_SIGNATURE_KEY?: string;
    AUTHORIZE_NET_ENVIRONMENT?: "sandbox" | "production";
    AUTHORIZE_NET_SUCCESS_REDIRECT_URL?: string;
    PUBLIC_BASE_URL?: string;
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
  PROVIDER_READS_ENABLED?: string;
  TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
}
