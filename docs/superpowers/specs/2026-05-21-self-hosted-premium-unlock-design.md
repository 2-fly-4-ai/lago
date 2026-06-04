# Self-Hosted Premium Unlock Design

## Goal

Make self-hosted Lago behave as premium by default, remove the self-hosted premium paywall UX, and replace Lago-owned remote premium dependencies with local/self-hosted implementations where feasible.

## Scope

In scope:
- backend premium gating currently driven by `License.premium?`
- organization premium add-on exposure via `premium_integrations`
- frontend premium warning/hidden-state behavior that exists only because premium is locked
- Lago-owned remote dependencies currently used for premium features:
  - license verification service
  - Data API HTTP proxy services
  - Mistral-specific AI conversation dependency
- explicit blocker inventory for vendor integrations and external connector infrastructure

Out of scope for the first implementation pass:
- reimplementing third-party vendor platforms themselves (`netsuite`, `okta`, `avalara`, `xero`, `hubspot`, `salesforce`, `anrok`)
- unrelated UI cleanup not required to unlock or replace premium behavior
- broad refactors beyond what is needed to preserve current feature behavior under self-hosted premium defaults

## Current Model

Premium behavior is enforced in two layers.

### 1. Global premium license

The backend uses `License.premium?` from `api/lib/lago_utils/lago_utils/license.rb`. In development and runtime this currently depends on a remote license verification service via `LAGO_LICENSE` and `LAGO_LICENSE_URL`.

This global gate blocks many backend services, GraphQL resolvers, jobs, and mutations.

### 2. Organization premium integrations

Organizations carry a `premium_integrations` array, and the frontend uses it extensively through GraphQL to decide whether to:
- show premium dialogs
- hide premium controls/tabs
- enable premium workflow branches

An unlock that changes only one layer is incomplete. Self-hosted premium must satisfy both layers.

## Target Model

### Premium defaults

Self-hosted Lago should be premium by default.

That means:
- `License.premium?` resolves true by default for self-hosted runtime
- organization premium integrations resolve to all values in `Organization::PREMIUM_INTEGRATIONS`
- new organizations are premium-enabled without extra setup
- existing organizations behave as premium-enabled without manual DB patching as a prerequisite for basic use

### Frontend behavior

The frontend should unlock primarily through truthful data rather than wholesale component deletion.

That means:
- `currentUser.premium` becomes true
- `organization.premiumIntegrations` returns the full premium set
- pages currently guarded by `hasOrganizationPremiumAddon(...)` unlock naturally
- premium warning dialogs/components become cleanup work after behavior is unlocked

### Service ownership split

We will distinguish between:
- Lago-owned remote dependencies that should be replaced locally
- third-party integrations that are real external connectors and must remain a separate blocker list

## Replacement Strategy

### License service

Keep the `License` interface, but remove the remote verification requirement from the self-hosted path.

Desired end state:
- runtime does not require a `license` service to use premium features locally
- tests can still exercise non-premium behavior explicitly
- callers of `License.premium?` do not need large rewrites

### Data API

Current `DataApi::*` services proxy over HTTP through `LAGO_DATA_API_URL`.

Target behavior:
- preserve existing resolver/service contracts where practical
- replace HTTP transport with in-process local query services
- reuse already-local analytics services where available
- add local implementations for Data API surfaces that currently only exist as HTTP proxy consumers

Primary surfaces:
- usages
- aggregated amounts
- invoiced usages
- forecasted usages
- MRRs
- MRR plan breakdowns
- revenue streams
- revenue stream customer/plan breakdowns
- prepaid credits

### AI conversations

Current AI conversation flow depends on:
- `MISTRAL_API_KEY`
- `MISTRAL_AGENT_ID`
- Mistral conversation APIs
- MCP setup via `LAGO_MCP_SERVER_URL`

Target behavior:
- remove the hard requirement for Mistral-specific credentials
- introduce a provider boundary so self-hosted can target a local or OpenAI-compatible model backend
- preserve Lago conversation persistence and streaming behavior as much as possible

This is the riskiest part of the first pass and may require a minimal compatibility implementation before a richer local AI backend exists.

## Lago-Owned Features That Should Work Locally

These premium features should become locally available once gating is removed and local services are wired:
- analytics dashboards
- revenue analytics
- forecasted usage
- projected usage
- progressive billing and lifetime-usage related surfaces
- manual payments
- API permissions
- preview / quotes / credit notes / issue receipts / custom roles / order forms / multi-entity premium behavior
- activity logs / API logs / security logs, provided the local ClickHouse/Kafka stack is enabled

## Explicit Blockers To Track

### Vendor / connector blockers

These are not just premium gates; they are true external integrations:
- netsuite
- okta
- avalara
- xero
- hubspot
- salesforce
- anrok

Related infrastructure dependencies also need separate treatment:
- `NANGO_SECRET_KEY`
- `LAGO_OAUTH_PROXY_URL` / hosted OAuth proxy flows

These must be documented as blockers or later replacement projects, not silently downgraded.

### First-pass engineering blockers

The hard implementation areas are:
- preserving non-premium test coverage while making self-hosted premium-default
- replacing Data API HTTP-backed services with local equivalents without breaking expected payload shapes
- replacing Mistral-specific AI plumbing without regressing streaming UX
- deciding whether organization premium exposure is DB-backed, computed, or both

## Verification

The first pass is complete when:
- `License.premium?` no longer depends on remote license verification for self-hosted runtime
- current users report premium access
- organizations expose all premium integrations in GraphQL
- premium UI warning flows no longer block self-hosted access
- Data API-backed premium screens use local implementations rather than a remote `data_api` service
- AI conversations no longer require Mistral-specific configuration to be considered available in self-hosted mode, or any remaining AI blocker is explicitly isolated and documented
- vendor integrations and connector infra blockers are documented explicitly rather than hidden behind generic premium warnings
