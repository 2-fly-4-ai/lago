# Self-Hosted Premium Blockers

This file records the remaining premium-adjacent features that still depend on connector or provider setup in self-hosted Lago.

## Already fixed in this branch

- premium is unlocked by default for self-hosted
- frontend premium paywall flows no longer need Lago sales contact paths
- Data API analytics fall back to local implementations when the hosted Data API is absent
- AI no longer hard-fails when Mistral is not configured
- AI can run against MiniMax via its OpenAI-compatible API without Lago-hosted dependencies
- Segment tracking is disabled by default in self-hosted compose/deploy templates

## Remaining self-hosted setup requirements

### Easy Pay Direct adapter

The Cloudflare-native adapter uses EPD Commerce for customers, payment methods, products, orders,
refunds, and authoritative webhooks. Sandbox needs a Demo Company Commerce key carrying EPD's
`_test_` environment marker,
a checkout-signing secret, and the endpoint's one-time `whsec_...` signing secret. Live card entry
additionally needs the EPD Gateway Payment API security key and Collect.js tokenization key because
Gateway still owns card vaulting. Enable `EASY_PAY_DIRECT_NETWORK_MODE=test` first and keep
`EASY_PAY_DIRECT_LIVEMODE_ALLOWED=0` independent. The Worker rejects a live key in sandbox mode and
a test key in production mode. Only a verified `order.*` webhook marks the local payment paid.

### Nango-backed integrations
These integrations still require local Nango configuration:

- Anrok
- Avalara
- HubSpot
- NetSuite
- Xero

Required configuration:

- backend: `NANGO_SECRET_KEY`
- frontend: `NANGO_PUBLIC_KEY`

Without those values, Lago now fails clearly instead of routing users to Lago-hosted upgrade/contact flows.

### GoCardless OAuth proxy
GoCardless still requires an OAuth callback/proxy URL that your self-hosted deployment controls.

Required configuration:

- `LAGO_OAUTH_PROXY_URL`

The default deploy templates in this branch no longer point to `proxy.getlago.com`.

## Telemetry defaults

Self-hosted templates now default `LAGO_DISABLE_SEGMENT=true`.

If you want Segment enabled, set:

- `SEGMENT_WRITE_KEY`
- optionally `LAGO_DISABLE_SEGMENT=false`

## AI

Self-hosted AI now supports a real non-Lago provider path.

Current behavior:

- if `MINIMAX_API_KEY` is configured, Lago uses MiniMax via `https://api.minimax.io/v1/chat/completions`
- if `LAGO_MCP_SERVER_URL` is also configured, MiniMax runs with Lago MCP tool access
- otherwise, if Mistral/MCP is configured, Lago still uses Mistral
- otherwise AI falls back to a safe null provider

Required MiniMax configuration:

- `MINIMAX_API_KEY`
- optional: `MINIMAX_MODEL` (defaults to `MiniMax-M3`)

Implementation note:

- AI conversation messages are now persisted locally for self-hosted history, so MiniMax does not depend on a hosted remote conversation store
