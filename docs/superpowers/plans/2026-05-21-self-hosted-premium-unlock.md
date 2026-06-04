# Self-Hosted Premium Unlock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make self-hosted Lago premium by default, unlock the premium UI path, replace Lago-owned premium remote dependencies with local/self-hosted implementations where feasible, and document external connector blockers explicitly.

**Architecture:** Keep the existing feature surfaces and contracts where possible, but replace the global premium truth source and remote transports underneath them. First make premium true by default and expose all premium integrations, then swap Data API HTTP proxies for local service implementations, then isolate the AI provider boundary so self-hosted no longer hard-depends on Mistral.

**Tech Stack:** Ruby on Rails, GraphQL, React/TypeScript, ClickHouse, Redpanda/Kafka, Docker Compose

---

## File Structure

### Backend premium-default core
- Modify: `api/lib/lago_utils/lago_utils/license.rb`
- Modify: `api/config/initializers/license.rb`
- Modify: `api/app/models/organization.rb`
- Modify: `api/app/graphql/types/user_type.rb`
- Modify: `api/app/graphql/types/organizations/current_organization_type.rb`
- Modify: `api/app/graphql/types/customer_portal/organizations/object.rb`
- Modify: `api/app/services/organizations/create_service.rb`
- Test: `api/spec/lib/lago_utils/license_spec.rb`
- Add/modify tests around GraphQL org/current-user premium exposure as needed

### Frontend unlock / dead-gate cleanup
- Modify: `front/src/hooks/useOrganizationInfos.ts`
- Modify: `front/src/components/premium/PremiumFeature.tsx`
- Modify: `front/src/components/dialogs/PremiumWarningDialog.tsx`
- Modify premium-gated pages/components only where data-driven unlock is not sufficient
- Add/modify targeted frontend tests for unlocked behavior

### Data API local replacement
- Modify: `api/app/services/data_api/base_service.rb`
- Modify: `api/app/services/data_api/usages_service.rb`
- Modify: `api/app/services/data_api/mrrs_service.rb`
- Modify: `api/app/services/data_api/prepaid_credits_service.rb`
- Modify: `api/app/services/data_api/revenue_streams_service.rb`
- Modify: `api/app/services/data_api/revenue_streams/customers_service.rb`
- Modify: `api/app/services/data_api/revenue_streams/plans_service.rb`
- Modify: `api/app/services/data_api/usages/aggregated_amounts_service.rb`
- Modify: `api/app/services/data_api/usages/invoiced_service.rb`
- Modify: `api/app/services/data_api/usages/forecasted_service.rb`
- Add local query helpers under `api/app/services/data_api/local/` as needed
- Test: `api/spec/services/data_api/**/*.rb`
- Test: `api/spec/graphql/resolvers/data_api/**/*.rb`

### AI provider decoupling
- Modify: `api/app/graphql/mutations/ai_conversations/create.rb`
- Modify: `api/app/graphql/resolvers/ai_conversations_resolver.rb`
- Modify: `api/app/graphql/resolvers/ai_conversation_resolver.rb`
- Modify: `api/app/services/ai_conversations/stream_service.rb`
- Modify: `api/app/services/ai_conversations/fetch_messages_service.rb`
- Add provider boundary under `api/app/services/ai_conversations/providers/`
- Potentially modify: `api/lib/lago_mcp_client/lago_mcp_client/mistral/*.rb`
- Add/modify AI conversation tests

### Blocker inventory docs
- Add: `docs/self-hosted-premium-blockers.md`

---

### Task 1: Make self-hosted premium by default in the backend

**Files:**
- Modify: `api/lib/lago_utils/lago_utils/license.rb`
- Modify: `api/config/initializers/license.rb`
- Modify: `api/app/models/organization.rb`
- Modify: `api/app/graphql/types/user_type.rb`
- Modify: `api/app/graphql/types/organizations/current_organization_type.rb`
- Modify: `api/app/graphql/types/customer_portal/organizations/object.rb`
- Modify: `api/app/services/organizations/create_service.rb`
- Test: `api/spec/lib/lago_utils/license_spec.rb`

- [ ] **Step 1: Write or update failing backend tests for premium-default behavior**

Target assertions:
- `License.premium?` is true by default in self-hosted runtime
- current user GraphQL premium field resolves true
- organization GraphQL premium integrations returns all values in `Organization::PREMIUM_INTEGRATIONS`
- newly created organizations get full premium integrations by default

Run focused tests first, for example:
```bash
cd /Users/brianfarley/Desktop/Githhub-project/lago/api
bundle exec rspec spec/lib/lago_utils/license_spec.rb
```
Expected: existing premium/license assumptions fail once new expectations are added.

- [ ] **Step 2: Replace remote license verification with local premium-default behavior**

Implement a narrow `License` behavior that keeps the public API but makes self-hosted premium true by default instead of requiring `LAGO_LICENSE` verification.

Core constraint:
```ruby
# callers continue using:
License.premium?
License.verify
```
But `verify` should no longer be required to contact a hosted license service for self-hosted runtime.

- [ ] **Step 3: Make organization premium exposure resolve to the full premium set**

Implement the premium integration exposure so the app sees all premium integrations by default.

Required effects:
```ruby
Organization::PREMIUM_INTEGRATIONS
# is exposed through GraphQL current org and customer portal org types
```
And organization helpers like:
```ruby
organization.progressive_billing_enabled?
organization.analytics_dashboards_enabled?
```
should resolve truthfully under the premium-default model.

- [ ] **Step 4: Ensure new organizations are premium-enabled by default**

Update organization creation so new self-hosted orgs do not start with a restricted premium state.

- [ ] **Step 5: Run backend verification**

Run:
```bash
cd /Users/brianfarley/Desktop/Githhub-project/lago/api
bundle exec rspec spec/lib/lago_utils/license_spec.rb
```
Expected: PASS

Then run targeted premium-related GraphQL/model tests you touched.

- [ ] **Step 6: Commit**

```bash
git add api/lib/lago_utils/lago_utils/license.rb api/config/initializers/license.rb api/app/models/organization.rb api/app/graphql/types/user_type.rb api/app/graphql/types/organizations/current_organization_type.rb api/app/graphql/types/customer_portal/organizations/object.rb api/app/services/organizations/create_service.rb api/spec/lib/lago_utils/license_spec.rb
git commit -m "feat: unlock premium by default for self-hosted"
```

### Task 2: Remove effective frontend premium gating for self-hosted

**Files:**
- Modify: `front/src/hooks/useOrganizationInfos.ts`
- Modify: `front/src/components/premium/PremiumFeature.tsx`
- Modify: `front/src/components/dialogs/PremiumWarningDialog.tsx`
- Modify premium-gated pages/components only where necessary
- Test: targeted frontend specs touching unlocked flows

- [ ] **Step 1: Add or update tests that prove premium-gated UI now unlocks**

Focus on currently blocked areas such as analytics, forecasts, API permissions, or projected usage.

Example commands (choose touched specs):
```bash
cd /Users/brianfarley/Desktop/Githhub-project/lago/front
pnpm test -- --runInBand src/pages/analytics/__tests__/NewAnalytics.test.tsx
```
Expected: FAIL if tests still assume locked state.

- [ ] **Step 2: Prefer data-driven unlock over page-by-page hacks**

Use the now-premium GraphQL responses so `hasOrganizationPremiumAddon(...)` and `isPremium` resolve true naturally.

Only edit `PremiumFeature` / `PremiumWarningDialog` usage where dead locked-state UI still renders despite premium data.

- [ ] **Step 3: Remove or neutralize stale premium CTA behavior where it is no longer reachable**

Examples:
```tsx
// avoid self-hosted premium contact/upgrade UX remaining visible
```
Keep changes scoped to self-hosted-unlock behavior; do not redesign unrelated UI.

- [ ] **Step 4: Run frontend verification**

Run targeted tests for touched premium-gated screens/components.

- [ ] **Step 5: Commit**

```bash
git add front/src/hooks/useOrganizationInfos.ts front/src/components/premium/PremiumFeature.tsx front/src/components/dialogs/PremiumWarningDialog.tsx
git commit -m "feat: remove self-hosted premium UI gates"
```

### Task 3: Replace remote Data API usage with local in-process services

**Files:**
- Modify: `api/app/services/data_api/base_service.rb`
- Modify: `api/app/services/data_api/*.rb`
- Modify: `api/app/services/data_api/usages/*.rb`
- Modify: `api/app/services/data_api/revenue_streams/*.rb`
- Modify: `api/app/services/data_api/mrrs/*.rb`
- Add: `api/app/services/data_api/local/*.rb` as needed
- Test: `api/spec/services/data_api/**/*.rb`
- Test: `api/spec/graphql/resolvers/data_api/**/*.rb`

- [ ] **Step 1: Write failing tests for one local Data API slice at a time**

Start with the simplest existing service contract and keep the payload shape stable.
Recommended order:
1. `mrrs`
2. `usages/invoiced`
3. `prepaid_credits`
4. `revenue_streams`
5. `forecasted` / `aggregated_amounts`

Run a single focused spec first, e.g.:
```bash
cd /Users/brianfarley/Desktop/Githhub-project/lago/api
bundle exec rspec spec/services/data_api/mrrs_service_spec.rb
```

- [ ] **Step 2: Replace BaseService HTTP assumptions with a transport-agnostic local path**

Refactor so Data API services no longer require:
```ruby
ENV["LAGO_DATA_API_URL"]
LagoHttpClient::Client
```
for self-hosted premium operation.

Keep the external call contract stable for callers:
```ruby
DataApi::MrrsService.call(organization, **params)
```

- [ ] **Step 3: Implement local equivalents using existing local analytics/services where possible**

Preferred reuse:
- local analytics services already in `api/app/services/analytics/`
- ClickHouse-backed local data already present in the stack
- existing DB models / query objects before inventing new APIs

Add `api/app/services/data_api/local/` only for missing local shapes.

- [ ] **Step 4: Preserve existing response payload shapes**

The GraphQL resolvers and frontend already expect the current structures. Match those structures rather than changing consumers unless absolutely necessary.

- [ ] **Step 5: Run service and resolver verification**

Run:
```bash
cd /Users/brianfarley/Desktop/Githhub-project/lago/api
bundle exec rspec spec/services/data_api spec/graphql/resolvers/data_api
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add api/app/services/data_api api/spec/services/data_api api/spec/graphql/resolvers/data_api
git commit -m "feat: replace remote data api with local services"
```

### Task 4: Replace Mistral-specific AI dependency with a self-hosted-capable provider boundary

**Files:**
- Modify: `api/app/graphql/mutations/ai_conversations/create.rb`
- Modify: `api/app/graphql/resolvers/ai_conversations_resolver.rb`
- Modify: `api/app/graphql/resolvers/ai_conversation_resolver.rb`
- Modify: `api/app/services/ai_conversations/stream_service.rb`
- Modify: `api/app/services/ai_conversations/fetch_messages_service.rb`
- Add: `api/app/services/ai_conversations/providers/*.rb`
- Modify: `api/app/models/ai_conversation.rb` if conversation metadata must stop being Mistral-specific
- Test: AI conversation mutation/service/resolver specs

- [ ] **Step 1: Add failing tests for self-hosted AI availability without Mistral-specific env vars**

Current forbidden checks key off:
```ruby
ENV["MISTRAL_API_KEY"]
ENV["MISTRAL_AGENT_ID"]
```
Add expectations for the new provider boundary instead.

- [ ] **Step 2: Introduce a provider interface for conversation streaming and history fetch**

Provide a narrow contract covering:
```ruby
start/append conversation
stream chunks
fetch saved messages
persist provider conversation identifiers
```

- [ ] **Step 3: Move Mistral-specific logic behind the provider boundary**

Do not leave GraphQL resolvers/mutations directly checking Mistral env vars after this task.

- [ ] **Step 4: Add a self-hosted-capable default provider path**

The first self-hosted path may target a local or OpenAI-compatible backend. If a full local provider is too large for this slice, isolate the blocker explicitly in code/docs rather than leaving Mistral checks scattered.

- [ ] **Step 5: Run AI verification**

Run touched AI specs and any targeted manual verification of streamed conversation behavior.

- [ ] **Step 6: Commit**

```bash
git add api/app/graphql/mutations/ai_conversations/create.rb api/app/graphql/resolvers/ai_conversations_resolver.rb api/app/graphql/resolvers/ai_conversation_resolver.rb api/app/services/ai_conversations api/app/models/ai_conversation.rb
git commit -m "feat: decouple ai conversations from mistral"
```

### Task 5: Document remaining external connector blockers explicitly

**Files:**
- Add: `docs/self-hosted-premium-blockers.md`

- [ ] **Step 1: Write the blocker inventory**

Document at minimum:
- vendor integrations still dependent on external platforms
- `NANGO_SECRET_KEY`
- `LAGO_OAUTH_PROXY_URL` / hosted proxy assumptions
- which premium features are now local/self-hosted
- which premium features remain blocked and why

- [ ] **Step 2: Verify doc accuracy against code touched in Tasks 1-4**

Manual review expected: the blocker doc must match reality, not aspiration.

- [ ] **Step 3: Commit**

```bash
git add docs/self-hosted-premium-blockers.md
git commit -m "docs: record self-hosted premium blockers"
```
