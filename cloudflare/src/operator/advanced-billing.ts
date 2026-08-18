import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import type { OperatorEnv } from "./access";

const PAYMENT_STATUSES = new Set(["pending", "requires_action", "succeeded", "failed", "refunded"]);
const DOCUMENT_LOCALES = new Set(["en", "fr", "de", "es", "it", "nb", "pt", "sv", "nl"]);
const CREDIT_NOTE_REASONS = new Set([
  "duplicated_charge",
  "product_unsatisfactory",
  "order_change",
  "order_cancellation",
  "fraudulent_charge",
  "other",
]);

type AdvancedEnv = Pick<OperatorEnv, "BILLING_DB" | "BILLING_ARTIFACTS">;

export async function handleOperatorAdvancedBillingRequest(
  request: Request,
  env: AdvancedEnv,
  organizationId: string,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/operator/v1/billing-entities/default/taxes") {
    if (request.method === "GET")
      return billingEntityTaxes(env.BILLING_DB, organizationId, requestId);
    if (request.method === "PUT")
      return replaceBillingEntityTaxes(request, env.BILLING_DB, organizationId, requestId);
  }
  if (path === "/api/operator/v1/billing-entities/default/dunning-campaign") {
    if (request.method === "GET")
      return billingEntityDunning(env.BILLING_DB, organizationId, requestId);
    if (request.method === "PUT")
      return updateBillingEntityDunning(request, env.BILLING_DB, organizationId, requestId);
    if (request.method === "DELETE")
      return clearBillingEntityDunning(env.BILLING_DB, organizationId, requestId);
  }
  if (path === "/api/operator/v1/billing-entities/default/logo") {
    if (request.method === "GET") return readBillingEntityLogo(env, organizationId, requestId);
    if (request.method === "PUT")
      return putBillingEntityLogo(request, env, organizationId, requestId);
    if (request.method === "DELETE") return deleteBillingEntityLogo(env, organizationId, requestId);
  }

  const customerTaxes = path.match(
    /^\/api\/operator\/v1\/customers\/([^/]+)\/taxes(?:\/([^/]+))?$/,
  );
  if (customerTaxes?.[1]) {
    const customerKey = decodeURIComponent(customerTaxes[1]);
    if (request.method === "GET" && !customerTaxes[2])
      return listCustomerTaxes(env.BILLING_DB, organizationId, customerKey, requestId);
    if (request.method === "POST" && !customerTaxes[2])
      return addCustomerTax(request, env.BILLING_DB, organizationId, customerKey, requestId);
    if (request.method === "DELETE" && customerTaxes[2])
      return removeCustomerTax(
        env.BILLING_DB,
        organizationId,
        customerKey,
        decodeURIComponent(customerTaxes[2]),
        requestId,
      );
  }

  const customerSettings = path.match(
    /^\/api\/operator\/v1\/customers\/([^/]+)\/document-settings$/,
  );
  if (customerSettings?.[1]) {
    const customerKey = decodeURIComponent(customerSettings[1]);
    if (request.method === "GET")
      return getCustomerDocumentSettings(env.BILLING_DB, organizationId, customerKey, requestId);
    if (request.method === "PUT")
      return updateCustomerDocumentSettings(
        request,
        env.BILLING_DB,
        organizationId,
        customerKey,
        requestId,
      );
    if (request.method === "DELETE")
      return clearCustomerDocumentSettings(env.BILLING_DB, organizationId, customerKey, requestId);
  }

  const customerDelete = path.match(/^\/api\/operator\/v1\/customers\/([^/]+)$/);
  if (customerDelete?.[1] && request.method === "DELETE") {
    return deleteCustomer(
      env.BILLING_DB,
      organizationId,
      decodeURIComponent(customerDelete[1]),
      requestId,
    );
  }

  const progressive = path.match(
    /^\/api\/operator\/v1\/subscriptions\/([^/]+)\/progressive-billing$/,
  );
  if (progressive?.[1]) {
    const subscriptionKey = decodeURIComponent(progressive[1]);
    if (request.method === "GET")
      return getSubscriptionProgressiveBilling(
        env.BILLING_DB,
        organizationId,
        subscriptionKey,
        requestId,
      );
    if (request.method === "PUT")
      return updateSubscriptionProgressiveBilling(
        request,
        env.BILLING_DB,
        organizationId,
        subscriptionKey,
        requestId,
      );
    if (request.method === "DELETE")
      return resetSubscriptionProgressiveBilling(
        env.BILLING_DB,
        organizationId,
        subscriptionKey,
        requestId,
      );
  }

  const metadata = path.match(/^\/api\/operator\/v1\/invoices\/([^/]+)\/metadata$/);
  if (metadata?.[1]) {
    const invoiceId = decodeURIComponent(metadata[1]);
    if (request.method === "GET")
      return getInvoiceMetadata(env.BILLING_DB, organizationId, invoiceId, requestId);
    if (request.method === "PUT")
      return replaceInvoiceMetadata(request, env.BILLING_DB, organizationId, invoiceId, requestId);
  }

  const paymentStatus = path.match(/^\/api\/operator\/v1\/invoices\/([^/]+)\/payment-status$/);
  if (paymentStatus?.[1] && request.method === "PUT") {
    return updateInvoicePaymentStatus(
      request,
      env.BILLING_DB,
      organizationId,
      decodeURIComponent(paymentStatus[1]),
      requestId,
    );
  }

  const adjustedFee = path.match(
    /^\/api\/operator\/v1\/invoices\/([^/]+)\/adjusted-fees(?:\/(preview|[^/]+))?$/,
  );
  if (adjustedFee?.[1]) {
    const invoiceId = decodeURIComponent(adjustedFee[1]);
    if (request.method === "GET" && !adjustedFee[2])
      return listAdjustedFees(env.BILLING_DB, organizationId, invoiceId, requestId);
    if (request.method === "POST" && adjustedFee[2] === "preview")
      return previewAdjustedFee(request, env.BILLING_DB, organizationId, invoiceId, requestId);
    if (request.method === "POST" && !adjustedFee[2])
      return createAdjustedFee(request, env.BILLING_DB, organizationId, invoiceId, requestId);
    if (request.method === "DELETE" && adjustedFee[2])
      return destroyAdjustedFee(
        env.BILLING_DB,
        organizationId,
        invoiceId,
        decodeURIComponent(adjustedFee[2]),
        requestId,
      );
  }

  const regenerate = path.match(/^\/api\/operator\/v1\/invoices\/([^/]+)\/regenerate$/);
  if (regenerate?.[1] && request.method === "POST")
    return regenerateInvoice(
      env.BILLING_DB,
      organizationId,
      decodeURIComponent(regenerate[1]),
      requestId,
    );

  if (path === "/api/operator/v1/credit-notes/estimate" && request.method === "POST")
    return estimateCreditNote(request, env.BILLING_DB, organizationId, requestId);

  const editCreditNote = path.match(/^\/api\/operator\/v1\/credit-notes\/([^/]+)$/);
  if (editCreditNote?.[1] && request.method === "PUT")
    return updateCreditNote(
      request,
      env.BILLING_DB,
      organizationId,
      decodeURIComponent(editCreditNote[1]),
      requestId,
    );

  return null;
}

async function billingEntityTaxes(database: D1Database, organizationId: string, requestId: string) {
  const taxes = await database
    .prepare(
      `SELECT id AS lago_id, code, name, rate, description
       FROM taxes WHERE organization_id = ? AND status = 'active' AND applied_to_organization = 1
       ORDER BY name, code`,
    )
    .bind(organizationId)
    .all();
  return json({ taxes: taxes.results }, { requestId });
}

async function replaceBillingEntityTaxes(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
) {
  const input = objectAt(await parseJsonObject(request), "billing_entity");
  const codes = uniqueStringArray(input.tax_codes, "tax_codes", 50);
  if (codes.length) {
    const found = await database
      .prepare(
        `SELECT code FROM taxes WHERE organization_id = ? AND status = 'active'
         AND code IN (${codes.map(() => "?").join(",")})`,
      )
      .bind(organizationId, ...codes)
      .all<{ code: string }>();
    if (found.results.length !== codes.length)
      throw new ApiError(422, "tax_not_found", "One or more selected taxes were not found");
  }
  const now = new Date().toISOString();
  const statements = [
    database
      .prepare(
        "UPDATE taxes SET applied_to_organization = 0, version = version + 1, updated_at = ? WHERE organization_id = ? AND status = 'active' AND applied_to_organization = 1",
      )
      .bind(now, organizationId),
    ...codes.map((code) =>
      database
        .prepare(
          "UPDATE taxes SET applied_to_organization = 1, version = version + 1, updated_at = ? WHERE organization_id = ? AND status = 'active' AND code = ?",
        )
        .bind(now, organizationId, code),
    ),
  ];
  await database.batch(statements);
  return billingEntityTaxes(database, organizationId, requestId);
}

async function billingEntityDunning(
  database: D1Database,
  organizationId: string,
  requestId: string,
) {
  const campaign = await database
    .prepare(
      `SELECT campaign.id AS lago_id, campaign.code, campaign.name, campaign.description
       FROM organizations organization LEFT JOIN dunning_campaigns campaign
         ON campaign.id = organization.applied_dunning_campaign_id AND campaign.active = 1
       WHERE organization.id = ? LIMIT 1`,
    )
    .bind(organizationId)
    .first();
  return json({ dunning_campaign: campaign?.lago_id ? campaign : null }, { requestId });
}

async function updateBillingEntityDunning(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
) {
  const input = objectAt(await parseJsonObject(request), "billing_entity");
  const code = requiredString(input, "dunning_campaign_code");
  const campaign = await database
    .prepare(
      "SELECT id FROM dunning_campaigns WHERE organization_id = ? AND code = ? AND active = 1",
    )
    .bind(organizationId, code)
    .first<{ id: string }>();
  if (!campaign)
    throw new ApiError(404, "dunning_campaign_not_found", "Dunning campaign was not found");
  await database
    .prepare(
      "UPDATE organizations SET applied_dunning_campaign_id = ?, version = version + 1, updated_at = ? WHERE id = ?",
    )
    .bind(campaign.id, new Date().toISOString(), organizationId)
    .run();
  return billingEntityDunning(database, organizationId, requestId);
}

async function clearBillingEntityDunning(
  database: D1Database,
  organizationId: string,
  requestId: string,
) {
  await database
    .prepare(
      "UPDATE organizations SET applied_dunning_campaign_id = NULL, version = version + 1, updated_at = ? WHERE id = ?",
    )
    .bind(new Date().toISOString(), organizationId)
    .run();
  return json({ dunning_campaign: null }, { requestId });
}

async function readBillingEntityLogo(env: AdvancedEnv, organizationId: string, requestId: string) {
  const bucket = requiredArtifactsBucket(env);
  const asset = await env.BILLING_DB.prepare(
    "SELECT object_key, mime_type, filename FROM billing_entity_assets WHERE organization_id = ?",
  )
    .bind(organizationId)
    .first<{ object_key: string; mime_type: string; filename: string }>();
  if (!asset)
    throw new ApiError(404, "billing_entity_logo_not_found", "Billing entity logo was not found");
  const object = await bucket.get(asset.object_key);
  if (!object)
    throw new ApiError(503, "artifact_missing", "Billing entity logo artifact is unavailable");
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${safeFilename(asset.filename)}"`,
      "Content-Type": asset.mime_type,
      "X-Request-Id": requestId,
    },
  });
}

async function putBillingEntityLogo(
  request: Request,
  env: AdvancedEnv,
  organizationId: string,
  requestId: string,
) {
  const bucket = requiredArtifactsBucket(env);
  const input = objectAt(await parseJsonObject(request), "logo");
  const mimeType = requiredString(input, "mime_type");
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType))
    throw new ApiError(422, "validation_error", "Logo must be PNG, JPEG, or WebP");
  const filename = requiredString(input, "filename");
  const encoded = requiredString(input, "data_base64");
  let bytes: Uint8Array;
  try {
    const binary = atob(encoded);
    bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  } catch {
    throw new ApiError(422, "validation_error", "Logo data_base64 is invalid");
  }
  if (!bytes.length || bytes.length > 1_048_576)
    throw new ApiError(422, "validation_error", "Logo must be between 1 byte and 1 MB");
  assertImageSignature(bytes, mimeType);
  const current = await env.BILLING_DB.prepare(
    "SELECT object_key, version FROM billing_entity_assets WHERE organization_id = ?",
  )
    .bind(organizationId)
    .first<{ object_key: string; version: number }>();
  const version = (current?.version ?? 0) + 1;
  const objectKey = `operator/billing-entity-logos/${organizationId}/v${version}`;
  await bucket.put(objectKey, bytes, { httpMetadata: { contentType: mimeType } });
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `INSERT INTO billing_entity_assets
     (organization_id, object_key, mime_type, filename, byte_size, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET object_key = excluded.object_key,
       mime_type = excluded.mime_type, filename = excluded.filename, byte_size = excluded.byte_size,
       version = excluded.version, updated_at = excluded.updated_at`,
  )
    .bind(
      organizationId,
      objectKey,
      mimeType,
      safeFilename(filename),
      bytes.length,
      version,
      now,
      now,
    )
    .run();
  if (current?.object_key && current.object_key !== objectKey)
    await bucket.delete(current.object_key);
  return json(
    {
      logo: {
        file_url: "/api/operator/v1/billing-entities/default/logo",
        mime_type: mimeType,
        filename: safeFilename(filename),
        version,
      },
    },
    { requestId },
  );
}

async function deleteBillingEntityLogo(
  env: AdvancedEnv,
  organizationId: string,
  requestId: string,
) {
  const bucket = requiredArtifactsBucket(env);
  const asset = await env.BILLING_DB.prepare(
    "SELECT object_key FROM billing_entity_assets WHERE organization_id = ?",
  )
    .bind(organizationId)
    .first<{ object_key: string }>();
  if (asset) {
    await env.BILLING_DB.prepare("DELETE FROM billing_entity_assets WHERE organization_id = ?")
      .bind(organizationId)
      .run();
    await bucket.delete(asset.object_key);
  }
  return json({ logo: null }, { requestId });
}

async function listCustomerTaxes(
  database: D1Database,
  organizationId: string,
  customerKey: string,
  requestId: string,
) {
  const customer = await requiredCustomer(database, organizationId, customerKey);
  const taxes = await database
    .prepare(
      `SELECT tax.id AS lago_id, tax.code, tax.name, tax.rate, tax.description
     FROM customer_applied_taxes link JOIN taxes tax ON tax.id = link.tax_id
     WHERE link.organization_id = ? AND link.customer_id = ? ORDER BY tax.name, tax.code`,
    )
    .bind(organizationId, customer.id)
    .all();
  return json({ taxes: taxes.results }, { requestId });
}

async function addCustomerTax(
  request: Request,
  database: D1Database,
  organizationId: string,
  customerKey: string,
  requestId: string,
) {
  const customer = await requiredCustomer(database, organizationId, customerKey);
  const input = objectAt(await parseJsonObject(request), "applied_tax");
  const code = requiredString(input, "tax_code");
  const tax = await database
    .prepare("SELECT id FROM taxes WHERE organization_id = ? AND code = ? AND status = 'active'")
    .bind(organizationId, code)
    .first<{ id: string }>();
  if (!tax) throw new ApiError(404, "tax_not_found", "Tax was not found");
  await database
    .prepare(
      "INSERT OR IGNORE INTO customer_applied_taxes (organization_id, customer_id, tax_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(organizationId, customer.id, tax.id, new Date().toISOString())
    .run();
  return listCustomerTaxes(database, organizationId, customerKey, requestId);
}

async function removeCustomerTax(
  database: D1Database,
  organizationId: string,
  customerKey: string,
  taxCode: string,
  requestId: string,
) {
  const customer = await requiredCustomer(database, organizationId, customerKey);
  await database
    .prepare(
      `DELETE FROM customer_applied_taxes WHERE organization_id = ? AND customer_id = ?
     AND tax_id IN (SELECT id FROM taxes WHERE organization_id = ? AND code = ?)`,
    )
    .bind(organizationId, customer.id, organizationId, taxCode)
    .run();
  return listCustomerTaxes(database, organizationId, customerKey, requestId);
}

async function getCustomerDocumentSettings(
  database: D1Database,
  organizationId: string,
  customerKey: string,
  requestId: string,
) {
  const customer = await requiredCustomer(database, organizationId, customerKey);
  return json({ document_settings: customerDocumentSettings(customer) }, { requestId });
}

async function updateCustomerDocumentSettings(
  request: Request,
  database: D1Database,
  organizationId: string,
  customerKey: string,
  requestId: string,
) {
  const customer = await requiredCustomer(database, organizationId, customerKey);
  const input = objectAt(await parseJsonObject(request), "document_settings");
  const locale =
    input.document_locale === null
      ? null
      : (optionalString(input, "document_locale") ?? customer.document_locale);
  if (locale && !DOCUMENT_LOCALES.has(locale))
    throw new ApiError(422, "validation_error", "document_locale is invalid");
  const adjustment =
    input.subscription_invoice_issuing_date_adjustment === null
      ? null
      : (optionalString(input, "subscription_invoice_issuing_date_adjustment") ??
        customer.subscription_invoice_issuing_date_adjustment);
  if (adjustment && adjustment !== "keep_anchor" && adjustment !== "align_with_finalization_date")
    throw new ApiError(422, "validation_error", "subscription invoice adjustment is invalid");
  const anchor =
    input.subscription_invoice_issuing_date_anchor === null
      ? null
      : (optionalString(input, "subscription_invoice_issuing_date_anchor") ??
        customer.subscription_invoice_issuing_date_anchor);
  if (anchor && anchor !== "current_period_end" && anchor !== "next_period_start")
    throw new ApiError(422, "validation_error", "subscription invoice anchor is invalid");
  const finalizeZero =
    input.finalize_zero_amount_invoice === undefined
      ? customer.finalize_zero_amount_invoice
      : input.finalize_zero_amount_invoice === null
        ? null
        : boolean(input.finalize_zero_amount_invoice, "finalize_zero_amount_invoice")
          ? 1
          : 0;
  await database
    .prepare(
      `UPDATE customers SET document_locale = ?, subscription_invoice_issuing_date_adjustment = ?,
     subscription_invoice_issuing_date_anchor = ?, finalize_zero_amount_invoice = ?,
     version = version + 1, updated_at = ?
     WHERE id = ? AND organization_id = ?`,
    )
    .bind(
      locale,
      adjustment,
      anchor,
      finalizeZero,
      new Date().toISOString(),
      customer.id,
      organizationId,
    )
    .run();
  return getCustomerDocumentSettings(database, organizationId, customerKey, requestId);
}

async function clearCustomerDocumentSettings(
  database: D1Database,
  organizationId: string,
  customerKey: string,
  requestId: string,
) {
  const customer = await requiredCustomer(database, organizationId, customerKey);
  await database
    .prepare(
      `UPDATE customers SET document_locale = NULL, subscription_invoice_issuing_date_adjustment = NULL,
     subscription_invoice_issuing_date_anchor = NULL, finalize_zero_amount_invoice = NULL,
     version = version + 1, updated_at = ?
     WHERE id = ? AND organization_id = ?`,
    )
    .bind(new Date().toISOString(), customer.id, organizationId)
    .run();
  return getCustomerDocumentSettings(database, organizationId, customerKey, requestId);
}

async function getSubscriptionProgressiveBilling(
  database: D1Database,
  organizationId: string,
  subscriptionKey: string,
  requestId: string,
) {
  const subscription = await requiredSubscription(database, organizationId, subscriptionKey);
  return json(
    {
      progressive_billing: {
        subscription_id: subscription.id,
        external_subscription_id: subscription.external_id,
        disabled: subscription.progressive_billing_disabled === 1,
      },
    },
    { requestId },
  );
}

async function updateSubscriptionProgressiveBilling(
  request: Request,
  database: D1Database,
  organizationId: string,
  subscriptionKey: string,
  requestId: string,
) {
  const subscription = await requiredSubscription(database, organizationId, subscriptionKey);
  const input = objectAt(await parseJsonObject(request), "progressive_billing");
  const disabled = boolean(input.disabled, "disabled");
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE subscriptions SET progressive_billing_disabled = ?, version = version + 1,
         updated_at = ? WHERE id = ? AND organization_id = ? AND version = ?`,
      )
      .bind(disabled ? 1 : 0, now, subscription.id, organizationId, subscription.version),
    outbox(
      database,
      organizationId,
      "subscription.progressive_billing_updated",
      "subscription",
      subscription.id,
      subscription.version + 1,
      requestId,
      now,
      { disabled },
    ),
  ]);
  return getSubscriptionProgressiveBilling(database, organizationId, subscriptionKey, requestId);
}

async function resetSubscriptionProgressiveBilling(
  database: D1Database,
  organizationId: string,
  subscriptionKey: string,
  requestId: string,
) {
  return updateSubscriptionProgressiveBilling(
    new Request("https://operator.invalid/progressive-billing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progressive_billing: { disabled: false } }),
    }),
    database,
    organizationId,
    subscriptionKey,
    requestId,
  );
}

async function deleteCustomer(
  database: D1Database,
  organizationId: string,
  customerKey: string,
  requestId: string,
) {
  const customer = await requiredCustomer(database, organizationId, customerKey);
  const dependency = await database
    .prepare(
      `SELECT
       (SELECT COUNT(*) FROM subscriptions WHERE customer_id = ?) +
       (SELECT COUNT(*) FROM invoices WHERE customer_id = ?) +
       (SELECT COUNT(*) FROM wallets WHERE customer_id = ?) +
       (SELECT COUNT(*) FROM payment_requests WHERE customer_id = ?) AS total`,
    )
    .bind(customer.id, customer.id, customer.id, customer.id)
    .first<{ total: number }>();
  if ((dependency?.total ?? 0) > 0)
    throw new ApiError(
      409,
      "customer_has_dependencies",
      "Customer cannot be deleted while billing records exist",
    );
  await database
    .prepare("DELETE FROM customers WHERE id = ? AND organization_id = ?")
    .bind(customer.id, organizationId)
    .run();
  return new Response(null, { status: 204, headers: { "X-Request-Id": requestId } });
}

async function getInvoiceMetadata(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  requestId: string,
) {
  await requiredInvoice(database, organizationId, invoiceId);
  const result = await database
    .prepare(
      "SELECT id AS lago_id, key, value FROM invoice_metadata WHERE organization_id = ? AND invoice_id = ? ORDER BY created_at, id",
    )
    .bind(organizationId, invoiceId)
    .all();
  return json({ metadata: result.results }, { requestId });
}

async function replaceInvoiceMetadata(
  request: Request,
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  requestId: string,
) {
  await requiredInvoice(database, organizationId, invoiceId);
  const body = await parseJsonObject(request);
  const values = body.metadata;
  if (!Array.isArray(values) || values.length > 20)
    throw new ApiError(
      422,
      "validation_error",
      "metadata must be an array with at most 20 entries",
    );
  const normalized = values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ApiError(422, "validation_error", `metadata[${index}] must be an object`);
    const row = value as Record<string, unknown>;
    const key = requiredString(row, "key");
    const metadataValue = requiredString(row, "value");
    if (key.length > 64 || metadataValue.length > 512)
      throw new ApiError(422, "validation_error", "Metadata key or value is too long");
    return { key, value: metadataValue };
  });
  if (new Set(normalized.map((row) => row.key)).size !== normalized.length)
    throw new ApiError(422, "validation_error", "Metadata keys must be unique");
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare("DELETE FROM invoice_metadata WHERE organization_id = ? AND invoice_id = ?")
      .bind(organizationId, invoiceId),
    ...normalized.map((row) =>
      database
        .prepare(
          "INSERT INTO invoice_metadata (id, organization_id, invoice_id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), organizationId, invoiceId, row.key, row.value, now, now),
    ),
  ]);
  return getInvoiceMetadata(database, organizationId, invoiceId, requestId);
}

async function updateInvoicePaymentStatus(
  request: Request,
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  requestId: string,
) {
  const invoice = await requiredInvoice(database, organizationId, invoiceId);
  const input = objectAt(await parseJsonObject(request), "invoice");
  const status = requiredString(input, "payment_status");
  if (!PAYMENT_STATUSES.has(status))
    throw new ApiError(422, "validation_error", "payment_status is invalid");
  if (invoice.status !== "finalized")
    throw new ApiError(
      422,
      "invoice_not_finalized",
      "Only finalized invoices have a payment status",
    );
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE invoices SET payment_status = ?, payment_overdue = CASE WHEN ? = 'succeeded' THEN 0 ELSE payment_overdue END,
       ready_for_payment_processing = CASE WHEN ? = 'succeeded' THEN 0 ELSE ready_for_payment_processing END,
       version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ? AND version = ?`,
      )
      .bind(status, status, status, now, invoice.id, organizationId, invoice.version),
    outbox(
      database,
      organizationId,
      "invoice.payment_status_updated",
      "invoice",
      invoice.id,
      invoice.version + 1,
      requestId,
      now,
      { payment_status: status },
    ),
  ]);
  return json({ invoice: { lago_id: invoice.id, payment_status: status } }, { requestId });
}

async function listAdjustedFees(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  requestId: string,
) {
  await requiredInvoice(database, organizationId, invoiceId);
  const result = await database
    .prepare(
      `SELECT id AS lago_id, invoice_line_id, description, quantity_decimal AS units,
     unit_amount_decimal AS unit_amount_cents, amount_minor AS amount_cents
     FROM adjusted_fees WHERE organization_id = ? AND invoice_id = ? ORDER BY created_at, id`,
    )
    .bind(organizationId, invoiceId)
    .all();
  return json({ adjusted_fees: result.results }, { requestId });
}

async function previewAdjustedFee(
  request: Request,
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  requestId: string,
) {
  const normalized = await normalizeAdjustedFee(request, database, organizationId, invoiceId);
  return json(
    { adjusted_fee: { ...normalized, lago_id: null, amount_cents: normalized.amountMinor } },
    { requestId },
  );
}

async function createAdjustedFee(
  request: Request,
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  requestId: string,
) {
  const normalized = await normalizeAdjustedFee(request, database, organizationId, invoiceId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO adjusted_fees (id, organization_id, invoice_id, invoice_line_id, description,
     quantity_decimal, unit_amount_decimal, amount_minor, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(invoice_id, invoice_line_id) DO UPDATE SET description = excluded.description,
       quantity_decimal = excluded.quantity_decimal, unit_amount_decimal = excluded.unit_amount_decimal,
       amount_minor = excluded.amount_minor, updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      organizationId,
      invoiceId,
      normalized.invoice_line_id,
      normalized.description,
      normalized.units,
      normalized.unit_amount_cents,
      normalized.amountMinor,
      now,
      now,
    )
    .run();
  return listAdjustedFees(database, organizationId, invoiceId, requestId);
}

async function destroyAdjustedFee(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  feeId: string,
  requestId: string,
) {
  await requiredInvoice(database, organizationId, invoiceId);
  await database
    .prepare("DELETE FROM adjusted_fees WHERE id = ? AND organization_id = ? AND invoice_id = ?")
    .bind(feeId, organizationId, invoiceId)
    .run();
  return listAdjustedFees(database, organizationId, invoiceId, requestId);
}

async function normalizeAdjustedFee(
  request: Request,
  database: D1Database,
  organizationId: string,
  invoiceId: string,
) {
  const invoice = await requiredInvoice(database, organizationId, invoiceId);
  if (invoice.status !== "voided" && invoice.status !== "finalized")
    throw new ApiError(
      422,
      "invoice_not_adjustable",
      "Only finalized or voided invoices can be adjusted",
    );
  const input = objectAt(await parseJsonObject(request), "adjusted_fee");
  const lineId = optionalString(input, "invoice_line_id");
  const line = lineId
    ? await database
        .prepare(
          "SELECT id, description, quantity_decimal, unit_amount_decimal FROM invoice_lines WHERE id = ? AND invoice_id = ?",
        )
        .bind(lineId, invoiceId)
        .first<{
          id: string;
          description: string;
          quantity_decimal: string;
          unit_amount_decimal: string;
        }>()
    : null;
  if (lineId && !line)
    throw new ApiError(404, "invoice_line_not_found", "Invoice line was not found");
  const description = optionalString(input, "description") ?? line?.description ?? "Adjusted fee";
  const units = decimal(input.units ?? line?.quantity_decimal ?? "1", "units");
  const unitAmount = decimal(
    input.unit_amount_cents ?? line?.unit_amount_decimal ?? "0",
    "unit_amount_cents",
  );
  const amountMinor = Math.round(Number(units) * Number(unitAmount));
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
    throw new ApiError(422, "validation_error", "Adjusted fee amount is invalid");
  return {
    invoice_line_id: lineId,
    description,
    units,
    unit_amount_cents: unitAmount,
    amountMinor,
  };
}

async function regenerateInvoice(
  database: D1Database,
  organizationId: string,
  sourceInvoiceId: string,
  requestId: string,
) {
  const existing = await database
    .prepare(
      "SELECT regenerated_invoice_id FROM invoice_regenerations WHERE organization_id = ? AND source_invoice_id = ?",
    )
    .bind(organizationId, sourceInvoiceId)
    .first<{ regenerated_invoice_id: string }>();
  if (existing)
    return json(
      { invoice: { lago_id: existing.regenerated_invoice_id, status: "draft" } },
      { requestId },
    );
  const source = await requiredInvoice(database, organizationId, sourceInvoiceId);
  if (source.status !== "voided")
    throw new ApiError(422, "invoice_not_voided", "Invoice must be voided before regeneration");
  const lines = await database
    .prepare(
      `SELECT id, line_type, description, quantity_decimal, unit_amount_decimal, amount_minor,
     source_type, source_id, metadata_json, display_order FROM invoice_lines WHERE invoice_id = ? ORDER BY display_order, created_at, id`,
    )
    .bind(sourceInvoiceId)
    .all<{
      id: string;
      line_type: string;
      description: string;
      quantity_decimal: string;
      unit_amount_decimal: string;
      amount_minor: number;
      source_type: string;
      source_id: string;
      metadata_json: string;
      display_order: number;
    }>();
  const adjustments = await database
    .prepare(
      "SELECT * FROM adjusted_fees WHERE organization_id = ? AND invoice_id = ? ORDER BY created_at, id",
    )
    .bind(organizationId, sourceInvoiceId)
    .all<{
      id: string;
      invoice_line_id: string | null;
      description: string;
      quantity_decimal: string;
      unit_amount_decimal: string;
      amount_minor: number;
    }>();
  const byLine = new Map(
    adjustments.results
      .filter((row) => row.invoice_line_id)
      .map((row) => [row.invoice_line_id as string, row]),
  );
  const finalLines = lines.results.map((line) => ({
    ...line,
    adjustment: byLine.get(line.id) ?? null,
  }));
  const appended = adjustments.results.filter((row) => !row.invoice_line_id);
  const subtotal =
    finalLines.reduce(
      (sum, line) => sum + (line.adjustment?.amount_minor ?? line.amount_minor),
      0,
    ) + appended.reduce((sum, row) => sum + row.amount_minor, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal < 0)
    throw new ApiError(422, "invalid_minor_amount", "Regenerated invoice total is invalid");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status,
        currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, issuing_date, created_at, updated_at, invoice_type, request_sha256,
        net_payment_term, payment_due_date, payment_overdue)
       VALUES (?, ?, ?, ?, NULL, 'draft', 'pending', ?, ?, 0, 0, ?, 1, NULL, ?, ?, ?, ?, NULL, ?, NULL, 0)`,
      )
      .bind(
        id,
        organizationId,
        source.customer_id,
        source.subscription_id,
        source.currency,
        subtotal,
        subtotal,
        now.slice(0, 10),
        now,
        now,
        source.invoice_type,
        source.net_payment_term,
      ),
  ];
  let order = 0;
  for (const line of finalLines) {
    const adjusted = line.adjustment;
    statements.push(
      database
        .prepare(
          `INSERT INTO invoice_lines (id, invoice_id, line_type, description, quantity_decimal,
       unit_amount_decimal, amount_minor, source_type, source_id, metadata_json, created_at, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          line.line_type,
          adjusted?.description ?? line.description,
          adjusted?.quantity_decimal ?? line.quantity_decimal,
          adjusted?.unit_amount_decimal ?? line.unit_amount_decimal,
          adjusted?.amount_minor ?? line.amount_minor,
          line.source_type,
          line.source_id,
          line.metadata_json,
          now,
          order++,
        ),
    );
  }
  for (const row of appended) {
    statements.push(
      database
        .prepare(
          `INSERT INTO invoice_lines (id, invoice_id, line_type, description, quantity_decimal,
       unit_amount_decimal, amount_minor, source_type, source_id, metadata_json, created_at, display_order)
       VALUES (?, ?, 'fee', ?, ?, ?, ?, 'adjusted_fee', ?, '{}', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          row.description,
          row.quantity_decimal,
          row.unit_amount_decimal,
          row.amount_minor,
          row.id,
          now,
          order++,
        ),
    );
  }
  statements.push(
    database
      .prepare(
        "INSERT INTO invoice_regenerations (organization_id, source_invoice_id, regenerated_invoice_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(organizationId, sourceInvoiceId, id, now),
  );
  await database.batch(statements);
  return json(
    {
      invoice: {
        lago_id: id,
        status: "draft",
        source_invoice_id: sourceInvoiceId,
        total_amount_cents: subtotal,
      },
    },
    { requestId, status: 201 },
  );
}

async function estimateCreditNote(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
) {
  const input = objectAt(await parseJsonObject(request), "credit_note");
  const invoiceId = requiredString(input, "invoice_id");
  const invoice = await requiredInvoice(database, organizationId, invoiceId);
  if (invoice.status !== "finalized")
    throw new ApiError(422, "invoice_not_finalized", "Only finalized invoices can be credited");
  if (!Array.isArray(input.items) || !input.items.length)
    throw new ApiError(422, "validation_error", "items must be a non-empty array");
  let total = 0;
  const items = [];
  for (const value of input.items) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ApiError(422, "validation_error", "Credit note item is invalid");
    const item = value as Record<string, unknown>;
    const feeId = requiredString(item, "fee_id");
    const amount = integer(item.amount_cents, "amount_cents", 1);
    const line = await database
      .prepare("SELECT id, amount_minor FROM invoice_lines WHERE id = ? AND invoice_id = ?")
      .bind(feeId, invoiceId)
      .first<{ id: string; amount_minor: number }>();
    if (!line || amount > line.amount_minor)
      throw new ApiError(
        422,
        "invalid_credit_note_item",
        "Credit note item exceeds its invoice fee",
      );
    total += amount;
    items.push({ fee_id: feeId, amount_cents: amount });
  }
  const available =
    invoice.subtotal_minor + invoice.tax_minor - invoice.coupons_minor - invoice.credit_notes_minor;
  if (total > available)
    throw new ApiError(
      422,
      "higher_than_remaining_invoice_amount",
      "Credit note exceeds the remaining invoice amount",
    );
  return json(
    {
      credit_note: {
        invoice_id: invoiceId,
        currency: invoice.currency,
        total_amount_cents: total,
        credit_amount_cents: total,
        balance_amount_cents: total,
        items,
      },
    },
    { requestId },
  );
}

async function updateCreditNote(
  request: Request,
  database: D1Database,
  organizationId: string,
  creditNoteId: string,
  requestId: string,
) {
  const current = await database
    .prepare(
      "SELECT id, reason, description, version FROM credit_notes WHERE organization_id = ? AND id = ?",
    )
    .bind(organizationId, creditNoteId)
    .first<{ id: string; reason: string; description: string | null; version: number }>();
  if (!current) throw new ApiError(404, "credit_note_not_found", "Credit note was not found");
  const input = objectAt(await parseJsonObject(request), "credit_note");
  const reason = optionalString(input, "reason") ?? current.reason;
  if (!CREDIT_NOTE_REASONS.has(reason))
    throw new ApiError(422, "validation_error", "reason is invalid");
  const description =
    input.description === null
      ? null
      : (optionalString(input, "description") ?? current.description);
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        "UPDATE credit_notes SET reason = ?, description = ?, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ? AND version = ?",
      )
      .bind(reason, description, now, creditNoteId, organizationId, current.version),
    outbox(
      database,
      organizationId,
      "credit_note.updated",
      "credit_note",
      creditNoteId,
      current.version + 1,
      requestId,
      now,
      { reason, description },
    ),
  ]);
  return json(
    { credit_note: { lago_id: creditNoteId, reason, description, version: current.version + 1 } },
    { requestId },
  );
}

type CustomerSettingsRow = {
  id: string;
  external_id: string;
  document_locale: string | null;
  subscription_invoice_issuing_date_adjustment: string | null;
  subscription_invoice_issuing_date_anchor: string | null;
  finalize_zero_amount_invoice: number | null;
};

async function requiredCustomer(
  database: D1Database,
  organizationId: string,
  customerKey: string,
): Promise<CustomerSettingsRow> {
  const customer = await database
    .prepare(
      `SELECT id, external_id, document_locale, subscription_invoice_issuing_date_adjustment,
     subscription_invoice_issuing_date_anchor, finalize_zero_amount_invoice FROM customers
     WHERE organization_id = ? AND (id = ? OR external_id = ?) LIMIT 1`,
    )
    .bind(organizationId, customerKey, customerKey)
    .first<CustomerSettingsRow>();
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");
  return customer;
}

function customerDocumentSettings(customer: CustomerSettingsRow) {
  return {
    customer_id: customer.id,
    external_customer_id: customer.external_id,
    document_locale: customer.document_locale,
    subscription_invoice_issuing_date_adjustment:
      customer.subscription_invoice_issuing_date_adjustment,
    subscription_invoice_issuing_date_anchor: customer.subscription_invoice_issuing_date_anchor,
    finalize_zero_amount_invoice:
      customer.finalize_zero_amount_invoice === null
        ? null
        : customer.finalize_zero_amount_invoice === 1,
  };
}

type SubscriptionPolicyRow = {
  id: string;
  external_id: string;
  progressive_billing_disabled: number;
  version: number;
};

async function requiredSubscription(
  database: D1Database,
  organizationId: string,
  subscriptionKey: string,
): Promise<SubscriptionPolicyRow> {
  const subscription = await database
    .prepare(
      `SELECT id, external_id, progressive_billing_disabled, version FROM subscriptions
       WHERE organization_id = ? AND (id = ? OR external_id = ?) LIMIT 1`,
    )
    .bind(organizationId, subscriptionKey, subscriptionKey)
    .first<SubscriptionPolicyRow>();
  if (!subscription)
    throw new ApiError(404, "subscription_not_found", "Subscription was not found");
  return subscription;
}

type InvoiceRow = {
  id: string;
  organization_id: string;
  customer_id: string;
  subscription_id: string | null;
  status: string;
  payment_status: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  coupons_minor: number;
  credit_notes_minor: number;
  invoice_type: string;
  net_payment_term: number;
  version: number;
};

async function requiredInvoice(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
): Promise<InvoiceRow> {
  const invoice = await database
    .prepare(
      `SELECT id, organization_id, customer_id, subscription_id, status, payment_status, currency,
     subtotal_minor, tax_minor, coupons_minor, credit_notes_minor, invoice_type, net_payment_term, version
     FROM invoices WHERE organization_id = ? AND id = ? LIMIT 1`,
    )
    .bind(organizationId, invoiceId)
    .first<InvoiceRow>();
  if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice was not found");
  return invoice;
}

function outbox(
  database: D1Database,
  organizationId: string,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  aggregateVersion: number,
  requestId: string,
  now: string,
  payload: Record<string, unknown>,
) {
  return database
    .prepare(
      `INSERT INTO outbox_events (event_id, organization_id, event_type, event_version,
     aggregate_type, aggregate_id, aggregate_version, causation_id, correlation_id,
     payload_json, occurred_at, published_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      crypto.randomUUID(),
      organizationId,
      eventType,
      aggregateType,
      aggregateId,
      aggregateVersion,
      requestId,
      requestId,
      JSON.stringify(payload),
      now,
    );
}

function uniqueStringArray(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new ApiError(
      422,
      "validation_error",
      `${name} must be an array with at most ${max} entries`,
    );
  const result = value.map((item) => {
    if (typeof item !== "string" || !item.trim())
      throw new ApiError(422, "validation_error", `${name} must contain non-empty strings`);
    return item.trim();
  });
  if (new Set(result).size !== result.length)
    throw new ApiError(422, "validation_error", `${name} must not contain duplicates`);
  return result;
}

function decimal(value: unknown, name: string): string {
  const text =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:\.\d{1,9})?$/.test(text) || Number(text) < 0 || !Number.isFinite(Number(text)))
    throw new ApiError(422, "validation_error", `${name} must be a non-negative decimal`);
  return text;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new ApiError(
      422,
      "validation_error",
      `${name} must be an integer of at least ${minimum}`,
    );
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new ApiError(422, "validation_error", `${name} must be boolean`);
  return value;
}

function safeFilename(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "logo";
}

function assertImageSignature(bytes: Uint8Array, mimeType: string) {
  const png =
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (
    (mimeType === "image/png" && !png) ||
    (mimeType === "image/jpeg" && !jpeg) ||
    (mimeType === "image/webp" && !webp)
  )
    throw new ApiError(422, "validation_error", "Logo bytes do not match mime_type");
}

function requiredArtifactsBucket(env: AdvancedEnv): R2Bucket {
  if (!env.BILLING_ARTIFACTS)
    throw new ApiError(
      503,
      "artifact_storage_unavailable",
      "Billing artifact storage is unavailable",
    );
  return env.BILLING_ARTIFACTS;
}
