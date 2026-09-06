-- A pre-production harness previously persisted obvious placeholder vault references. Ensure
-- those references can never be selected as reusable payment credentials.
UPDATE subscriptions
SET payment_method_type = NULL,
    payment_method_id = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE payment_method_type = 'provider'
  AND payment_method_id IN (
    SELECT id
    FROM provider_customer_profiles
    WHERE provider = 'easy_pay_direct'
      AND (
        lower(gateway_customer_vault_id) LIKE 'vault-test-%'
        OR lower(gateway_customer_vault_id) LIKE 'synthetic-%'
      )
  );

UPDATE provider_customer_profiles
SET initial_transaction_id = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE provider = 'easy_pay_direct'
  AND (
    lower(gateway_customer_vault_id) LIKE 'vault-test-%'
    OR lower(gateway_customer_vault_id) LIKE 'synthetic-%'
  );
