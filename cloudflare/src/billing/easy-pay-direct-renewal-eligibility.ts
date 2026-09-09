export type CollectionScopeMode = "scoped" | "product_scoped" | "all";

// Alias: profile. Commerce cards must originate from a proved, consented initial
// checkout. A customer default or a UUID-shaped legacy identifier is not authority.
export function savedProfileEligibilitySql(): string {
  return `(CASE profile.payment_backend WHEN 'gateway_vault' THEN (
    (length(trim(profile.gateway_customer_vault_id)) > 0 AND length(trim(profile.initial_transaction_id)) > 0)
    AND (lower(profile.gateway_customer_vault_id) NOT LIKE 'vault-test-%'
    AND lower(profile.gateway_customer_vault_id) NOT LIKE 'synthetic-%'))
  WHEN 'commerce_elements' THEN (
    (length(profile.provider_customer_id) = 36 AND length(profile.provider_payment_method_id) = 36)
    AND (profile.gateway_customer_vault_id IS NULL AND profile.gateway_billing_id IS NULL)
    AND EXISTS (
      SELECT 1 FROM easy_pay_direct_payment_executions initial_execution
      JOIN payment_request_checkout_intents initial_intent ON initial_intent.id = initial_execution.checkout_intent_id
      JOIN payment_requests initial_request ON initial_request.id = initial_execution.payment_request_id
      WHERE ((initial_execution.checkout_intent_id = profile.checkout_intent_id
        AND initial_execution.organization_id = profile.organization_id)
        AND (initial_execution.provider_account_code = profile.provider_account_code
        AND initial_execution.payment_backend = 'commerce_elements'))
        AND ((initial_execution.status = 'succeeded' AND initial_execution.terms_accepted_at IS NOT NULL)
        AND (initial_execution.provider_customer_id = profile.provider_customer_id
        AND initial_execution.provider_payment_method_id = profile.provider_payment_method_id))
        AND ((initial_execution.provider_transaction_id IS NOT NULL
        AND initial_request.payment_status = 'succeeded')
        AND ((initial_intent.organization_id = profile.organization_id AND initial_intent.customer_id = profile.customer_id)
        AND (initial_request.organization_id = profile.organization_id AND initial_request.customer_id = profile.customer_id)))
    )) ELSE 0 END)`;
}

export function configuredAutomaticCollectionScope(
  env: Partial<Pick<Env, "EASY_PAY_DIRECT_ORGANIZATION_ID" | "EASY_PAY_DIRECT_ACCOUNT_CODE">>,
): { organizationId: string; accountCode: string } | null {
  const organizationId = env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim();
  const accountCode = env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim();
  return organizationId && accountCode ? { organizationId, accountCode } : null;
}

export function automaticCollectionScopeMode(
  env: Partial<Pick<Env, "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE">>,
): CollectionScopeMode {
  if (env.EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE === "product_scoped")
    return "product_scoped";
  return env.EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE === "all" ? "all" : "scoped";
}

export function productPolicyEligibilitySql(mode: CollectionScopeMode): string {
  if (mode !== "product_scoped") return "1 = 1";
  return `EXISTS (
    SELECT 1 FROM subscription_checkout_products attribution
    JOIN easy_pay_direct_product_collection_policies policy
      ON policy.organization_id = attribution.organization_id
      AND policy.product_slug = attribution.product_slug AND policy.status = 'enabled'
    WHERE attribution.subscription_id = subscription.id
      AND attribution.organization_id = subscription.organization_id
  )`;
}

// Requires invoice/subscription/plan/profile aliases and one bound scope-mode.
// Shared by request creation and the final atomic external-charge claim.
export function recurringSubscriptionEligibilitySql(mode: CollectionScopeMode): string {
  return `subscription.payment_method_type = 'provider'
    AND subscription.payment_method_id = profile.id
    AND subscription.status IN ('active', 'past_due')
    AND plan.interval IN ('weekly', 'monthly', 'quarterly', 'yearly')
    AND ${productPolicyEligibilitySql(mode)}
    AND (? = 'all' OR EXISTS (
      SELECT 1 FROM easy_pay_direct_automatic_collection_scopes scope
      WHERE scope.subscription_id = subscription.id
        AND scope.organization_id = invoice.organization_id AND scope.status = 'enabled'
    ))`;
}
