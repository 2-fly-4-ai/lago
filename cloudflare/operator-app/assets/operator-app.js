const endpoints = {
  session: "/api/operator/v1/session",
  organization: "/api/operator/v1/organization",
  billingEntity: "/api/operator/v1/billing-entities/default",
  apiKeys: "/api/operator/v1/api-keys",
  invoiceSections: "/api/operator/v1/invoice-custom-sections",
  paymentReceipts: "/api/operator/v1/payment-receipts",
  taxes: "/api/operator/v1/taxes",
  addOns: "/api/operator/v1/add-ons",
};

const elements = {
  loading: document.querySelector("#loading-state"),
  closed: document.querySelector("#closed-state"),
  closedTitle: document.querySelector("#closed-title"),
  closedMessage: document.querySelector("#closed-message"),
  dashboard: document.querySelector("#dashboard"),
  workspaceName: document.querySelector("#workspace-name"),
  operatorBadge: document.querySelector("#operator-badge"),
  operatorRole: document.querySelector("#operator-role"),
  rolePill: document.querySelector("#role-pill"),
  pageError: document.querySelector("#page-error"),
  pageErrorMessage: document.querySelector("#page-error-message"),
  dismissError: document.querySelector("#dismiss-error"),
  organizationMonogram: document.querySelector("#organization-monogram"),
  organizationTitle: document.querySelector("#organization-title"),
  organizationSlug: document.querySelector("#organization-slug"),
  organizationCurrency: document.querySelector("#organization-currency"),
  organizationTimezone: document.querySelector("#organization-timezone"),
  organizationVersion: document.querySelector("#organization-version"),
  openEditBilling: document.querySelector("#open-edit-billing"),
  billingLoading: document.querySelector("#billing-loading"),
  billingProfileGrid: document.querySelector("#billing-profile-grid"),
  billingLegalName: document.querySelector("#billing-legal-name"),
  billingLegalNumber: document.querySelector("#billing-legal-number"),
  billingEmail: document.querySelector("#billing-email"),
  billingAddress: document.querySelector("#billing-address"),
  billingPaymentTerms: document.querySelector("#billing-payment-terms"),
  billingNumbering: document.querySelector("#billing-numbering"),
  billingPrefix: document.querySelector("#billing-prefix"),
  billingDocumentLocale: document.querySelector("#billing-document-locale"),
  billingZeroInvoices: document.querySelector("#billing-zero-invoices"),
  billingTaxCount: document.querySelector("#billing-tax-count"),
  billingSectionCount: document.querySelector("#billing-section-count"),
  billingFormDialog: document.querySelector("#billing-form-dialog"),
  billingForm: document.querySelector("#billing-form"),
  billingName: document.querySelector("#billing-name"),
  billingFormEmail: document.querySelector("#billing-form-email"),
  billingFormLegalName: document.querySelector("#billing-form-legal-name"),
  billingFormLegalNumber: document.querySelector("#billing-form-legal-number"),
  billingTaxId: document.querySelector("#billing-tax-id"),
  billingCountry: document.querySelector("#billing-country"),
  billingAddressLine1: document.querySelector("#billing-address-line1"),
  billingAddressLine2: document.querySelector("#billing-address-line2"),
  billingCity: document.querySelector("#billing-city"),
  billingState: document.querySelector("#billing-state"),
  billingZipcode: document.querySelector("#billing-zipcode"),
  billingCurrency: document.querySelector("#billing-currency"),
  billingTimezone: document.querySelector("#billing-timezone"),
  billingNetTerm: document.querySelector("#billing-net-term"),
  billingGracePeriod: document.querySelector("#billing-grace-period"),
  billingDocumentNumbering: document.querySelector("#billing-document-numbering"),
  billingDocumentPrefix: document.querySelector("#billing-document-prefix"),
  billingLocale: document.querySelector("#billing-locale"),
  billingFooter: document.querySelector("#billing-footer"),
  billingFinalizeZero: document.querySelector("#billing-finalize-zero"),
  billingFormError: document.querySelector("#billing-form-error"),
  submitBillingForm: document.querySelector("#submit-billing-form"),
  openCreateKey: document.querySelector("#open-create-key"),
  keysLoading: document.querySelector("#keys-loading"),
  keysEmpty: document.querySelector("#keys-empty"),
  keysEmptyCopy: document.querySelector("#keys-empty-copy"),
  keysTableShell: document.querySelector("#keys-table-shell"),
  keysTableBody: document.querySelector("#keys-table-body"),
  openCreateSection: document.querySelector("#open-create-section"),
  sectionsLoading: document.querySelector("#sections-loading"),
  sectionsEmpty: document.querySelector("#sections-empty"),
  sectionsEmptyCopy: document.querySelector("#sections-empty-copy"),
  sectionsTableShell: document.querySelector("#sections-table-shell"),
  sectionsTableBody: document.querySelector("#sections-table-body"),
  receiptsLoading: document.querySelector("#receipts-loading"),
  receiptsEmpty: document.querySelector("#receipts-empty"),
  receiptsTableShell: document.querySelector("#receipts-table-shell"),
  receiptsTableBody: document.querySelector("#receipts-table-body"),
  openCreateTax: document.querySelector("#open-create-tax"),
  taxesLoading: document.querySelector("#taxes-loading"),
  taxesEmpty: document.querySelector("#taxes-empty"),
  taxesEmptyCopy: document.querySelector("#taxes-empty-copy"),
  taxesTableShell: document.querySelector("#taxes-table-shell"),
  taxesTableBody: document.querySelector("#taxes-table-body"),
  taxFormDialog: document.querySelector("#tax-form-dialog"),
  taxForm: document.querySelector("#tax-form"),
  taxFormTitle: document.querySelector("#tax-form-title"),
  taxFormCopy: document.querySelector("#tax-form-copy"),
  taxName: document.querySelector("#tax-name"),
  taxCode: document.querySelector("#tax-code"),
  taxRate: document.querySelector("#tax-rate"),
  taxDescription: document.querySelector("#tax-description"),
  taxApplied: document.querySelector("#tax-applied-to-organization"),
  taxFormError: document.querySelector("#tax-form-error"),
  submitTaxForm: document.querySelector("#submit-tax-form"),
  openCreateAddOn: document.querySelector("#open-create-add-on"),
  addOnsLoading: document.querySelector("#add-ons-loading"),
  addOnsEmpty: document.querySelector("#add-ons-empty"),
  addOnsEmptyCopy: document.querySelector("#add-ons-empty-copy"),
  addOnsTableShell: document.querySelector("#add-ons-table-shell"),
  addOnsTableBody: document.querySelector("#add-ons-table-body"),
  addOnFormDialog: document.querySelector("#add-on-form-dialog"),
  addOnForm: document.querySelector("#add-on-form"),
  addOnFormTitle: document.querySelector("#add-on-form-title"),
  addOnFormCopy: document.querySelector("#add-on-form-copy"),
  addOnName: document.querySelector("#add-on-name"),
  addOnCode: document.querySelector("#add-on-code"),
  addOnAmount: document.querySelector("#add-on-amount"),
  addOnCurrency: document.querySelector("#add-on-currency"),
  addOnInvoiceName: document.querySelector("#add-on-invoice-name"),
  addOnDescription: document.querySelector("#add-on-description"),
  addOnFormError: document.querySelector("#add-on-form-error"),
  submitAddOnForm: document.querySelector("#submit-add-on-form"),
  keyFormDialog: document.querySelector("#key-form-dialog"),
  keyForm: document.querySelector("#key-form"),
  keyFormTitle: document.querySelector("#key-form-title"),
  keyFormCopy: document.querySelector("#key-form-copy"),
  keyName: document.querySelector("#key-name"),
  keyFormError: document.querySelector("#key-form-error"),
  submitKeyForm: document.querySelector("#submit-key-form"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmForm: document.querySelector("#confirm-form"),
  confirmTitle: document.querySelector("#confirm-title"),
  confirmCopy: document.querySelector("#confirm-copy"),
  confirmError: document.querySelector("#confirm-error"),
  confirmAction: document.querySelector("#confirm-action"),
  secretDialog: document.querySelector("#secret-dialog"),
  secretValue: document.querySelector("#secret-value"),
  copySecret: document.querySelector("#copy-secret"),
  copyStatus: document.querySelector("#copy-status"),
  closeSecret: document.querySelector("#close-secret"),
  closeSecretTop: document.querySelector("#close-secret-top"),
  sectionFormDialog: document.querySelector("#section-form-dialog"),
  sectionForm: document.querySelector("#section-form"),
  sectionTitle: document.querySelector("#section-title"),
  sectionFormCopy: document.querySelector("#section-form-copy"),
  sectionName: document.querySelector("#section-name"),
  sectionCode: document.querySelector("#section-code"),
  sectionDisplayName: document.querySelector("#section-display-name"),
  sectionDescription: document.querySelector("#section-description"),
  sectionDetails: document.querySelector("#section-details"),
  sectionFormError: document.querySelector("#section-form-error"),
  submitSectionForm: document.querySelector("#submit-section-form"),
};

const state = {
  role: "viewer",
  keys: [],
  keyFormMode: "create",
  selectedKeyId: null,
  confirmMode: null,
  oneTimeSecret: null,
  sections: [],
  sectionFormMode: "create",
  selectedSectionCode: null,
  billingEntity: null,
  receipts: [],
  taxes: [],
  taxFormMode: "create",
  selectedTaxCode: null,
  addOns: [],
  addOnFormMode: "create",
  selectedAddOnCode: null,
};

elements.dismissError.addEventListener("click", hidePageError);
elements.openCreateKey.addEventListener("click", openCreateDialog);
elements.keysTableBody.addEventListener("click", handleKeyAction);
elements.keyForm.addEventListener("submit", submitKeyForm);
elements.confirmForm.addEventListener("submit", submitConfirmedAction);
elements.copySecret.addEventListener("click", copyOneTimeSecret);
elements.closeSecret.addEventListener("click", closeSecretDialog);
elements.closeSecretTop.addEventListener("click", closeSecretDialog);
elements.secretDialog.addEventListener("cancel", clearOneTimeSecret);
elements.secretDialog.addEventListener("close", clearOneTimeSecret);
elements.openCreateSection.addEventListener("click", openCreateSectionDialog);
elements.sectionsTableBody.addEventListener("click", handleSectionAction);
elements.sectionForm.addEventListener("submit", submitSectionForm);
elements.openEditBilling.addEventListener("click", openBillingDialog);
elements.billingForm.addEventListener("submit", submitBillingForm);
elements.openCreateTax.addEventListener("click", openCreateTaxDialog);
elements.taxesTableBody.addEventListener("click", handleTaxAction);
elements.taxForm.addEventListener("submit", submitTaxForm);
elements.openCreateAddOn.addEventListener("click", openCreateAddOnDialog);
elements.addOnsTableBody.addEventListener("click", handleAddOnAction);
elements.addOnForm.addEventListener("submit", submitAddOnForm);

void initialize();

async function initialize() {
  try {
    const session = await requestJson(endpoints.session);
    const operator = session.operator;
    state.role = operator.role === "admin" ? "admin" : "viewer";
    const [
      organizationPayload,
      billingPayload,
      keyPayload,
      sectionsPayload,
      receiptsPayload,
      taxesPayload,
      addOnsPayload,
    ] = await Promise.all([
      requestJson(endpoints.organization),
      requestJson(endpoints.billingEntity),
      requestJson(endpoints.apiKeys),
      requestJson(endpoints.invoiceSections),
      requestJson(endpoints.paymentReceipts),
      requestJson(endpoints.taxes),
      requestJson(endpoints.addOns),
    ]);
    renderOperator(operator);
    renderOrganization(organizationPayload.organization);
    renderBillingEntity(billingPayload.billing_entity);
    renderKeys(keyPayload.api_keys);
    renderSections(sectionsPayload.invoice_custom_sections);
    renderReceipts(receiptsPayload.payment_receipts);
    renderTaxes(taxesPayload.taxes);
    renderAddOns(addOnsPayload.add_ons);
    elements.loading.hidden = true;
    elements.dashboard.hidden = false;
  } catch (error) {
    showClosedState(error);
  }
}

function renderOperator(operator) {
  const isAdmin = state.role === "admin";
  elements.operatorRole.textContent = isAdmin ? "Administrator" : "Read-only viewer";
  elements.operatorBadge.hidden = false;
  elements.rolePill.textContent = isAdmin ? "Admin access" : "Viewer access";
  elements.rolePill.classList.toggle("admin", isAdmin);
  elements.openCreateKey.hidden = !isAdmin;
  elements.openCreateSection.hidden = !isAdmin;
  elements.openEditBilling.hidden = !isAdmin;
  elements.openCreateTax.hidden = !isAdmin;
  elements.openCreateAddOn.hidden = !isAdmin;
  elements.keysEmptyCopy.textContent = isAdmin
    ? "Create a credential when a trusted service needs billing API access."
    : "This organization has no active API credentials. Admin access is required to create one.";
  elements.sectionsEmptyCopy.textContent = isAdmin
    ? "Create a reusable section when invoices need organization-specific content."
    : "This organization has no manual invoice sections. Admin access is required to create one.";
  elements.taxesEmptyCopy.textContent = isAdmin
    ? "Create a manual percentage tax for supported billing resources."
    : "This organization has no active manual taxes. Admin access is required to create one.";
  elements.addOnsEmptyCopy.textContent = isAdmin
    ? "Create an add-on for a supported fixed-charge workflow."
    : "This organization has no active add-ons. Admin access is required to create one.";
  if (operator.organization_external_id) {
    elements.workspaceName.textContent = operator.organization_external_id;
  }
}

function renderOrganization(organization) {
  const name = safeText(organization.name, "Unnamed organization");
  elements.organizationTitle.textContent = name;
  elements.organizationSlug.textContent = safeText(organization.slug, "No organization slug");
  elements.organizationCurrency.textContent = safeText(organization.default_currency, "—");
  elements.organizationTimezone.textContent = safeText(organization.timezone, "—");
  elements.organizationVersion.textContent = `v${Number(organization.version) || 1}`;
  elements.organizationMonogram.textContent = initials(name);
  elements.workspaceName.textContent = name;
}

function renderBillingEntity(entity) {
  state.billingEntity = entity && typeof entity === "object" ? entity : null;
  if (!state.billingEntity) return;

  elements.billingLegalName.textContent = safeText(entity.legal_name, safeText(entity.name, "—"));
  elements.billingLegalNumber.textContent = entity.legal_number
    ? `Legal number: ${entity.legal_number}`
    : "No legal number";
  elements.billingEmail.textContent = safeText(entity.email, "No billing email");
  elements.billingAddress.textContent = billingAddress(entity);
  elements.billingPaymentTerms.textContent = `${nonNegativeNumber(entity.net_payment_term)} days`;
  elements.billingNumbering.textContent =
    entity.document_numbering === "per_customer" ? "Per customer" : "Per billing entity";
  elements.billingPrefix.textContent = entity.document_number_prefix
    ? `Prefix: ${entity.document_number_prefix}`
    : "No document prefix";
  elements.billingDocumentLocale.textContent = safeText(entity.document_locale, "—");
  elements.billingZeroInvoices.textContent = entity.finalize_zero_amount_invoice
    ? "Zero-amount invoices finalize"
    : "Zero-amount invoices stay draft";
  elements.billingTaxCount.textContent = countLabel(entity.taxes, "tax", "taxes");
  elements.billingSectionCount.textContent = countLabel(
    entity.selected_invoice_custom_sections,
    "section",
    "sections",
  );
  elements.billingLoading.hidden = true;
  elements.billingProfileGrid.hidden = false;
}

function openBillingDialog() {
  if (state.role !== "admin" || !state.billingEntity) return;
  const entity = state.billingEntity;
  elements.billingName.value = formValue(entity.name);
  elements.billingFormEmail.value = formValue(entity.email);
  elements.billingFormLegalName.value = formValue(entity.legal_name);
  elements.billingFormLegalNumber.value = formValue(entity.legal_number);
  elements.billingTaxId.value = formValue(entity.tax_identification_number);
  elements.billingCountry.value = formValue(entity.country);
  elements.billingAddressLine1.value = formValue(entity.address_line1);
  elements.billingAddressLine2.value = formValue(entity.address_line2);
  elements.billingCity.value = formValue(entity.city);
  elements.billingState.value = formValue(entity.state);
  elements.billingZipcode.value = formValue(entity.zipcode);
  elements.billingCurrency.value = formValue(entity.default_currency);
  elements.billingTimezone.value = formValue(entity.timezone);
  elements.billingNetTerm.value = String(nonNegativeNumber(entity.net_payment_term));
  elements.billingGracePeriod.value = String(nonNegativeNumber(entity.invoice_grace_period));
  elements.billingDocumentNumbering.value =
    entity.document_numbering === "per_customer" ? "per_customer" : "per_billing_entity";
  elements.billingDocumentPrefix.value = formValue(entity.document_number_prefix);
  elements.billingLocale.value = formValue(entity.document_locale);
  elements.billingFooter.value = formValue(entity.invoice_footer);
  elements.billingFinalizeZero.checked = entity.finalize_zero_amount_invoice === true;
  elements.billingFormError.hidden = true;
  elements.billingFormDialog.showModal();
  elements.billingName.focus();
}

async function submitBillingForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.billingFormDialog.close();
    return;
  }
  if (!elements.billingForm.reportValidity()) return;

  const payload = {
    billing_entity: {
      name: elements.billingName.value.trim(),
      email: optionalFormValue(elements.billingFormEmail.value),
      legal_name: optionalFormValue(elements.billingFormLegalName.value),
      legal_number: optionalFormValue(elements.billingFormLegalNumber.value),
      tax_identification_number: optionalFormValue(elements.billingTaxId.value),
      country: optionalFormValue(elements.billingCountry.value),
      address_line1: optionalFormValue(elements.billingAddressLine1.value),
      address_line2: optionalFormValue(elements.billingAddressLine2.value),
      city: optionalFormValue(elements.billingCity.value),
      state: optionalFormValue(elements.billingState.value),
      zipcode: optionalFormValue(elements.billingZipcode.value),
      default_currency: elements.billingCurrency.value.trim(),
      timezone: elements.billingTimezone.value.trim(),
      net_payment_term: Number(elements.billingNetTerm.value),
      document_numbering: elements.billingDocumentNumbering.value,
      document_number_prefix: optionalFormValue(elements.billingDocumentPrefix.value),
      finalize_zero_amount_invoice: elements.billingFinalizeZero.checked,
      billing_configuration: {
        invoice_footer: optionalFormValue(elements.billingFooter.value),
        invoice_grace_period: Number(elements.billingGracePeriod.value),
        document_locale: elements.billingLocale.value.trim(),
      },
    },
  };

  setBusy(elements.submitBillingForm, true, "Saving…");
  elements.billingFormError.hidden = true;
  try {
    const response = await requestJson(endpoints.billingEntity, { method: "PUT", body: payload });
    renderBillingEntity(response.billing_entity);
    elements.billingFormDialog.close();
    try {
      const organizationPayload = await requestJson(endpoints.organization);
      renderOrganization(organizationPayload.organization);
      hidePageError();
    } catch (error) {
      showPageError(errorMessage(error));
    }
  } catch (error) {
    elements.billingFormError.textContent = errorMessage(error);
    elements.billingFormError.hidden = false;
  } finally {
    setBusy(elements.submitBillingForm, false, "Save billing profile");
  }
}

function renderKeys(keys) {
  state.keys = Array.isArray(keys) ? keys : [];
  elements.keysTableBody.replaceChildren();
  elements.keysLoading.hidden = true;
  elements.keysEmpty.hidden = state.keys.length !== 0;
  elements.keysTableShell.hidden = state.keys.length === 0;

  for (const key of state.keys) {
    elements.keysTableBody.append(createKeyRow(key));
  }
}

function createKeyRow(key) {
  const row = document.createElement("tr");
  const nameCell = document.createElement("td");
  const name = document.createElement("span");
  name.className = "key-name";
  name.textContent = safeText(key.name, "Unnamed key");
  const id = document.createElement("span");
  id.className = "key-id";
  id.textContent = safeText(key.id, "—");
  nameCell.append(name, id);

  const valueCell = document.createElement("td");
  const value = document.createElement("span");
  value.className = "masked-value";
  value.textContent = safeText(key.value, "••••••••");
  valueCell.append(value);

  const createdCell = document.createElement("td");
  createdCell.textContent = formatDate(key.created_at);
  const usedCell = document.createElement("td");
  usedCell.className = key.last_used_at ? "" : "muted";
  usedCell.textContent = key.last_used_at ? formatDate(key.last_used_at) : "Never";

  const actionCell = document.createElement("td");
  actionCell.className = "actions-column";
  if (state.role === "admin") {
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(
      actionButton("Rename", "rename", key.id),
      actionButton("Rotate", "rotate", key.id),
      actionButton("Revoke", "revoke", key.id, true),
    );
    actionCell.append(actions);
  } else {
    const readOnly = document.createElement("span");
    readOnly.className = "muted";
    readOnly.textContent = "Read only";
    actionCell.append(readOnly);
  }

  row.append(nameCell, valueCell, createdCell, usedCell, actionCell);
  return row;
}

function renderSections(sections) {
  state.sections = Array.isArray(sections) ? sections : [];
  elements.sectionsTableBody.replaceChildren();
  elements.sectionsLoading.hidden = true;
  elements.sectionsEmpty.hidden = state.sections.length !== 0;
  elements.sectionsTableShell.hidden = state.sections.length === 0;

  for (const section of state.sections) {
    elements.sectionsTableBody.append(createSectionRow(section));
  }
}

function createSectionRow(section) {
  const row = document.createElement("tr");
  const nameCell = document.createElement("td");
  const name = document.createElement("span");
  name.className = "key-name";
  name.textContent = safeText(section.name, "Unnamed section");
  const description = document.createElement("span");
  description.className = "key-id";
  description.textContent = safeText(section.description, "No description");
  nameCell.append(name, description);

  const codeCell = document.createElement("td");
  const code = document.createElement("span");
  code.className = "code-chip";
  code.textContent = safeText(section.code, "—");
  codeCell.append(code);

  const displayCell = document.createElement("td");
  displayCell.textContent = safeText(section.display_name, "—");
  if (!section.display_name) displayCell.className = "muted";

  const detailsCell = document.createElement("td");
  const details = document.createElement("span");
  details.className = section.details ? "section-details" : "section-details muted";
  details.textContent = safeText(section.details, "No details");
  detailsCell.append(details);

  const actionCell = document.createElement("td");
  actionCell.className = "actions-column";
  if (state.role === "admin") {
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(
      sectionActionButton("Edit", "edit-section", section.code),
      sectionActionButton("Terminate", "terminate-section", section.code, true),
    );
    actionCell.append(actions);
  } else {
    const readOnly = document.createElement("span");
    readOnly.className = "muted";
    readOnly.textContent = "Read only";
    actionCell.append(readOnly);
  }

  row.append(nameCell, codeCell, displayCell, detailsCell, actionCell);
  return row;
}

function renderReceipts(receipts) {
  state.receipts = Array.isArray(receipts) ? receipts : [];
  elements.receiptsTableBody.replaceChildren();
  elements.receiptsLoading.hidden = true;
  elements.receiptsEmpty.hidden = state.receipts.length !== 0;
  elements.receiptsTableShell.hidden = state.receipts.length === 0;
  for (const receipt of state.receipts)
    elements.receiptsTableBody.append(createReceiptRow(receipt));
}

function createReceiptRow(receipt) {
  const payment = receipt?.payment && typeof receipt.payment === "object" ? receipt.payment : {};
  const row = document.createElement("tr");
  const receiptCell = document.createElement("td");
  const number = document.createElement("span");
  number.className = "key-name";
  number.textContent = safeText(receipt.number, "Unnamed receipt");
  const id = document.createElement("span");
  id.className = "key-id";
  id.textContent = safeText(receipt.lago_id, "—");
  receiptCell.append(number, id);

  const customerCell = document.createElement("td");
  customerCell.textContent = safeText(payment.external_customer_id, "—");
  const invoicesCell = document.createElement("td");
  invoicesCell.textContent = Array.isArray(payment.invoice_numbers)
    ? payment.invoice_numbers.join(", ") || "—"
    : "—";
  const amountCell = document.createElement("td");
  amountCell.textContent = formatMoney(payment.amount_cents, payment.amount_currency);
  const statusCell = document.createElement("td");
  const status = document.createElement("span");
  status.className = "code-chip";
  status.textContent = safeText(payment.payment_status, "unknown");
  statusCell.append(status);
  const createdCell = document.createElement("td");
  createdCell.textContent = formatDate(receipt.created_at);
  row.append(receiptCell, customerCell, invoicesCell, amountCell, statusCell, createdCell);
  return row;
}

function renderTaxes(taxes) {
  state.taxes = Array.isArray(taxes) ? taxes : [];
  elements.taxesTableBody.replaceChildren();
  elements.taxesLoading.hidden = true;
  elements.taxesEmpty.hidden = state.taxes.length !== 0;
  elements.taxesTableShell.hidden = state.taxes.length === 0;
  for (const tax of state.taxes) elements.taxesTableBody.append(createTaxRow(tax));
}

function createTaxRow(tax) {
  const row = document.createElement("tr");
  const nameCell = document.createElement("td");
  const name = document.createElement("span");
  name.className = "key-name";
  name.textContent = safeText(tax.name, "Unnamed tax");
  const description = document.createElement("span");
  description.className = "key-id";
  description.textContent = safeText(tax.description, "No description");
  nameCell.append(name, description);
  const codeCell = document.createElement("td");
  const code = document.createElement("span");
  code.className = "code-chip";
  code.textContent = safeText(tax.code, "—");
  codeCell.append(code);
  const rateCell = document.createElement("td");
  rateCell.textContent = `${Number(tax.rate) || 0}%`;
  const defaultCell = document.createElement("td");
  defaultCell.textContent = tax.applied_to_organization ? "Yes" : "No";
  const actionCell = document.createElement("td");
  actionCell.className = "actions-column";
  if (state.role === "admin") {
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(
      taxActionButton("Edit", "edit-tax", tax.code),
      taxActionButton("Terminate", "terminate-tax", tax.code, true),
    );
    actionCell.append(actions);
  } else {
    actionCell.textContent = "Read only";
    actionCell.classList.add("muted");
  }
  row.append(nameCell, codeCell, rateCell, defaultCell, actionCell);
  return row;
}

function taxActionButton(label, action, code, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "row-action danger" : "row-action";
  button.dataset.action = action;
  button.dataset.taxCode = code;
  button.textContent = label;
  return button;
}

function handleTaxAction(event) {
  const button = event.target.closest("button[data-tax-code]");
  if (!button || state.role !== "admin") return;
  const tax = state.taxes.find((candidate) => candidate.code === button.dataset.taxCode);
  if (!tax) return;
  if (button.dataset.action === "edit-tax") openEditTaxDialog(tax);
  if (button.dataset.action === "terminate-tax") openTaxTermination(tax);
}

function openCreateTaxDialog() {
  state.taxFormMode = "create";
  state.selectedTaxCode = null;
  elements.taxFormTitle.textContent = "Create manual tax";
  elements.taxFormCopy.textContent = "Create a percentage tax for this organization.";
  elements.submitTaxForm.textContent = "Create tax";
  elements.taxForm.reset();
  elements.taxFormError.hidden = true;
  elements.taxFormDialog.showModal();
  elements.taxName.focus();
}

function openEditTaxDialog(tax) {
  state.taxFormMode = "edit";
  state.selectedTaxCode = tax.code;
  elements.taxFormTitle.textContent = "Edit manual tax";
  elements.taxFormCopy.textContent = "Update this tax for future supported billing operations.";
  elements.submitTaxForm.textContent = "Save tax";
  elements.taxName.value = formValue(tax.name);
  elements.taxCode.value = formValue(tax.code);
  elements.taxRate.value = String(Number(tax.rate) || 0);
  elements.taxDescription.value = formValue(tax.description);
  elements.taxApplied.checked = tax.applied_to_organization === true;
  elements.taxFormError.hidden = true;
  elements.taxFormDialog.showModal();
  elements.taxName.focus();
}

async function submitTaxForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.taxFormDialog.close();
    return;
  }
  if (!elements.taxForm.reportValidity()) return;
  const isCreate = state.taxFormMode === "create";
  setBusy(elements.submitTaxForm, true, isCreate ? "Creating…" : "Saving…");
  elements.taxFormError.hidden = true;
  try {
    await requestJson(isCreate ? endpoints.taxes : taxEndpoint(state.selectedTaxCode), {
      method: isCreate ? "POST" : "PUT",
      body: {
        tax: {
          name: elements.taxName.value.trim(),
          code: elements.taxCode.value.trim(),
          rate: elements.taxRate.value,
          description: optionalFormValue(elements.taxDescription.value),
          applied_to_organization: elements.taxApplied.checked,
        },
      },
    });
    elements.taxFormDialog.close();
    await refreshTaxes();
  } catch (error) {
    elements.taxFormError.textContent = errorMessage(error);
    elements.taxFormError.hidden = false;
  } finally {
    setBusy(elements.submitTaxForm, false, isCreate ? "Create tax" : "Save tax");
  }
}

function openTaxTermination(tax) {
  state.confirmMode = "terminate-tax";
  state.selectedTaxCode = tax.code;
  elements.confirmError.hidden = true;
  elements.confirmTitle.textContent = "Terminate manual tax?";
  elements.confirmCopy.textContent = `Terminating “${safeText(tax.name, "Unnamed tax")}” removes it from the active tax catalog and organization defaults.`;
  elements.confirmAction.textContent = "Terminate tax";
  elements.confirmDialog.showModal();
}

function renderAddOns(addOns) {
  state.addOns = Array.isArray(addOns) ? addOns : [];
  elements.addOnsTableBody.replaceChildren();
  elements.addOnsLoading.hidden = true;
  elements.addOnsEmpty.hidden = state.addOns.length !== 0;
  elements.addOnsTableShell.hidden = state.addOns.length === 0;
  for (const addOn of state.addOns) elements.addOnsTableBody.append(createAddOnRow(addOn));
}

function createAddOnRow(addOn) {
  const row = document.createElement("tr");
  const nameCell = document.createElement("td");
  const name = document.createElement("span");
  name.className = "key-name";
  name.textContent = safeText(addOn.name, "Unnamed add-on");
  const description = document.createElement("span");
  description.className = "key-id";
  description.textContent = safeText(addOn.description, "No description");
  nameCell.append(name, description);
  const codeCell = document.createElement("td");
  const code = document.createElement("span");
  code.className = "code-chip";
  code.textContent = safeText(addOn.code, "—");
  codeCell.append(code);
  const amountCell = document.createElement("td");
  amountCell.textContent = formatMoney(addOn.amount_cents, addOn.amount_currency);
  const invoiceCell = document.createElement("td");
  invoiceCell.textContent = safeText(addOn.invoice_display_name, "—");
  const actionCell = document.createElement("td");
  actionCell.className = "actions-column";
  if (state.role === "admin") {
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(
      addOnActionButton("Edit", "edit-add-on", addOn.code),
      addOnActionButton("Terminate", "terminate-add-on", addOn.code, true),
    );
    actionCell.append(actions);
  } else {
    actionCell.textContent = "Read only";
    actionCell.classList.add("muted");
  }
  row.append(nameCell, codeCell, amountCell, invoiceCell, actionCell);
  return row;
}

function addOnActionButton(label, action, code, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "row-action danger" : "row-action";
  button.dataset.action = action;
  button.dataset.addOnCode = code;
  button.textContent = label;
  return button;
}

function handleAddOnAction(event) {
  const button = event.target.closest("button[data-add-on-code]");
  if (!button || state.role !== "admin") return;
  const addOn = state.addOns.find((candidate) => candidate.code === button.dataset.addOnCode);
  if (!addOn) return;
  if (button.dataset.action === "edit-add-on") openEditAddOnDialog(addOn);
  if (button.dataset.action === "terminate-add-on") openAddOnTermination(addOn);
}

function openCreateAddOnDialog() {
  state.addOnFormMode = "create";
  state.selectedAddOnCode = null;
  elements.addOnFormTitle.textContent = "Create add-on";
  elements.addOnFormCopy.textContent = "Create a reusable fixed-price item.";
  elements.submitAddOnForm.textContent = "Create add-on";
  elements.addOnForm.reset();
  elements.addOnFormError.hidden = true;
  elements.addOnFormDialog.showModal();
  elements.addOnName.focus();
}

function openEditAddOnDialog(addOn) {
  state.addOnFormMode = "edit";
  state.selectedAddOnCode = addOn.code;
  elements.addOnFormTitle.textContent = "Edit add-on";
  elements.addOnFormCopy.textContent = "Update this item for future supported fixed charges.";
  elements.submitAddOnForm.textContent = "Save add-on";
  elements.addOnName.value = formValue(addOn.name);
  elements.addOnCode.value = formValue(addOn.code);
  elements.addOnAmount.value = String(nonNegativeNumber(addOn.amount_cents));
  elements.addOnCurrency.value = formValue(addOn.amount_currency);
  elements.addOnInvoiceName.value = formValue(addOn.invoice_display_name);
  elements.addOnDescription.value = formValue(addOn.description);
  elements.addOnFormError.hidden = true;
  elements.addOnFormDialog.showModal();
  elements.addOnName.focus();
}

async function submitAddOnForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.addOnFormDialog.close();
    return;
  }
  if (!elements.addOnForm.reportValidity()) return;
  const isCreate = state.addOnFormMode === "create";
  setBusy(elements.submitAddOnForm, true, isCreate ? "Creating…" : "Saving…");
  elements.addOnFormError.hidden = true;
  try {
    await requestJson(isCreate ? endpoints.addOns : addOnEndpoint(state.selectedAddOnCode), {
      method: isCreate ? "POST" : "PUT",
      body: {
        add_on: {
          name: elements.addOnName.value.trim(),
          code: elements.addOnCode.value.trim(),
          amount_cents: Number(elements.addOnAmount.value),
          amount_currency: elements.addOnCurrency.value.trim(),
          invoice_display_name: optionalFormValue(elements.addOnInvoiceName.value),
          description: optionalFormValue(elements.addOnDescription.value),
        },
      },
    });
    elements.addOnFormDialog.close();
    await refreshAddOns();
  } catch (error) {
    elements.addOnFormError.textContent = errorMessage(error);
    elements.addOnFormError.hidden = false;
  } finally {
    setBusy(elements.submitAddOnForm, false, isCreate ? "Create add-on" : "Save add-on");
  }
}

function openAddOnTermination(addOn) {
  state.confirmMode = "terminate-add-on";
  state.selectedAddOnCode = addOn.code;
  elements.confirmError.hidden = true;
  elements.confirmTitle.textContent = "Terminate add-on?";
  elements.confirmCopy.textContent = `Terminating “${safeText(addOn.name, "Unnamed add-on")}” removes it from the active catalog. In-use add-ons are protected by the billing service.`;
  elements.confirmAction.textContent = "Terminate add-on";
  elements.confirmDialog.showModal();
}

function sectionActionButton(label, action, code, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "row-action danger" : "row-action";
  button.dataset.action = action;
  button.dataset.sectionCode = code;
  button.textContent = label;
  return button;
}

function actionButton(label, action, keyId, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "row-action danger" : "row-action";
  button.dataset.action = action;
  button.dataset.keyId = keyId;
  button.textContent = label;
  return button;
}

function handleKeyAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button || state.role !== "admin") return;
  const key = state.keys.find((candidate) => candidate.id === button.dataset.keyId);
  if (!key) return;

  if (button.dataset.action === "rename") {
    openRenameDialog(key);
  } else if (button.dataset.action === "rotate") {
    openConfirmation("rotate", key);
  } else if (button.dataset.action === "revoke") {
    openConfirmation("revoke", key);
  }
}

function handleSectionAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button || state.role !== "admin") return;
  const section = state.sections.find((candidate) => candidate.code === button.dataset.sectionCode);
  if (!section) return;

  if (button.dataset.action === "edit-section") {
    openEditSectionDialog(section);
  } else if (button.dataset.action === "terminate-section") {
    openSectionTermination(section);
  }
}

function openCreateDialog() {
  state.keyFormMode = "create";
  state.selectedKeyId = null;
  elements.keyFormTitle.textContent = "Create API key";
  elements.keyFormCopy.textContent =
    "Give the credential a name that identifies the trusted service using it.";
  elements.submitKeyForm.textContent = "Create key";
  elements.keyName.value = "";
  elements.keyFormError.hidden = true;
  elements.keyFormDialog.showModal();
  elements.keyName.focus();
}

function openRenameDialog(key) {
  state.keyFormMode = "rename";
  state.selectedKeyId = key.id;
  elements.keyFormTitle.textContent = "Rename API key";
  elements.keyFormCopy.textContent =
    "Change the label used to identify this credential. The secret will not change.";
  elements.submitKeyForm.textContent = "Save name";
  elements.keyName.value = safeText(key.name, "");
  elements.keyFormError.hidden = true;
  elements.keyFormDialog.showModal();
  elements.keyName.focus();
  elements.keyName.select();
}

async function submitKeyForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.keyFormDialog.close();
    return;
  }
  if (!elements.keyForm.reportValidity()) return;

  const name = elements.keyName.value.trim();
  const isCreate = state.keyFormMode === "create";
  setBusy(elements.submitKeyForm, true, isCreate ? "Creating…" : "Saving…");
  elements.keyFormError.hidden = true;
  try {
    const payload = await requestJson(
      isCreate ? endpoints.apiKeys : keyEndpoint(state.selectedKeyId),
      {
        method: isCreate ? "POST" : "PUT",
        body: { api_key: { name } },
      },
    );
    elements.keyFormDialog.close();
    if (isCreate) revealOneTimeSecret(payload.api_key.value);
    await refreshKeys();
  } catch (error) {
    elements.keyFormError.textContent = errorMessage(error);
    elements.keyFormError.hidden = false;
  } finally {
    setBusy(elements.submitKeyForm, false, isCreate ? "Create key" : "Save name");
  }
}

function openCreateSectionDialog() {
  state.sectionFormMode = "create";
  state.selectedSectionCode = null;
  elements.sectionTitle.textContent = "Create custom section";
  elements.sectionFormCopy.textContent =
    "Create a reusable manual text block for organization invoices.";
  elements.submitSectionForm.textContent = "Create section";
  elements.sectionForm.reset();
  elements.sectionFormError.hidden = true;
  elements.sectionFormDialog.showModal();
  elements.sectionName.focus();
}

function openEditSectionDialog(section) {
  state.sectionFormMode = "edit";
  state.selectedSectionCode = section.code;
  elements.sectionTitle.textContent = "Edit custom section";
  elements.sectionFormCopy.textContent =
    "Update this reusable invoice text block. Existing finalized invoices remain immutable.";
  elements.submitSectionForm.textContent = "Save section";
  elements.sectionName.value = safeText(section.name, "");
  elements.sectionCode.value = safeText(section.code, "");
  elements.sectionDisplayName.value = safeText(section.display_name, "");
  elements.sectionDescription.value = safeText(section.description, "");
  elements.sectionDetails.value = safeText(section.details, "");
  elements.sectionFormError.hidden = true;
  elements.sectionFormDialog.showModal();
  elements.sectionName.focus();
  elements.sectionName.select();
}

async function submitSectionForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.sectionFormDialog.close();
    return;
  }
  if (!elements.sectionForm.reportValidity()) return;

  const isCreate = state.sectionFormMode === "create";
  const payload = {
    invoice_custom_section: {
      name: elements.sectionName.value.trim(),
      code: elements.sectionCode.value.trim(),
      display_name: optionalFormValue(elements.sectionDisplayName.value),
      description: optionalFormValue(elements.sectionDescription.value),
      details: optionalFormValue(elements.sectionDetails.value),
    },
  };
  setBusy(elements.submitSectionForm, true, isCreate ? "Creating…" : "Saving…");
  elements.sectionFormError.hidden = true;
  try {
    await requestJson(
      isCreate ? endpoints.invoiceSections : sectionEndpoint(state.selectedSectionCode),
      { method: isCreate ? "POST" : "PUT", body: payload },
    );
    elements.sectionFormDialog.close();
    await refreshSections();
  } catch (error) {
    elements.sectionFormError.textContent = errorMessage(error);
    elements.sectionFormError.hidden = false;
  } finally {
    setBusy(elements.submitSectionForm, false, isCreate ? "Create section" : "Save section");
  }
}

function openSectionTermination(section) {
  state.confirmMode = "terminate-section";
  state.selectedSectionCode = section.code;
  elements.confirmError.hidden = true;
  elements.confirmTitle.textContent = "Terminate custom section?";
  elements.confirmCopy.textContent = `Terminating “${safeText(section.name, "Unnamed section")}” removes it from the active catalog and future invoice selections. Finalized invoices remain unchanged.`;
  elements.confirmAction.textContent = "Terminate section";
  elements.confirmDialog.showModal();
}

function openConfirmation(mode, key) {
  state.confirmMode = mode;
  state.selectedKeyId = key.id;
  elements.confirmError.hidden = true;
  if (mode === "rotate") {
    elements.confirmTitle.textContent = "Rotate API key?";
    elements.confirmCopy.textContent = `Rotating “${safeText(key.name, "Unnamed key")}” immediately expires the current credential and creates a replacement secret.`;
    elements.confirmAction.textContent = "Rotate key";
  } else {
    elements.confirmTitle.textContent = "Revoke API key?";
    elements.confirmCopy.textContent = `Revoking “${safeText(key.name, "Unnamed key")}” immediately prevents it from authenticating. This cannot be undone.`;
    elements.confirmAction.textContent = "Revoke key";
  }
  elements.confirmDialog.showModal();
}

async function submitConfirmedAction(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.confirmDialog.close();
    return;
  }

  const mode = state.confirmMode;
  if (mode === "terminate-section") {
    const section = state.sections.find(
      (candidate) => candidate.code === state.selectedSectionCode,
    );
    if (!section) {
      elements.confirmDialog.close();
      return;
    }
    setBusy(elements.confirmAction, true, "Terminating…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(sectionEndpoint(section.code), { method: "DELETE" });
      elements.confirmDialog.close();
      await refreshSections();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, "Terminate section");
    }
    return;
  }

  if (mode === "terminate-tax") {
    const tax = state.taxes.find((candidate) => candidate.code === state.selectedTaxCode);
    if (!tax) {
      elements.confirmDialog.close();
      return;
    }
    setBusy(elements.confirmAction, true, "Terminating…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(taxEndpoint(tax.code), { method: "DELETE" });
      elements.confirmDialog.close();
      await refreshTaxes();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, "Terminate tax");
    }
    return;
  }

  if (mode === "terminate-add-on") {
    const addOn = state.addOns.find((candidate) => candidate.code === state.selectedAddOnCode);
    if (!addOn) {
      elements.confirmDialog.close();
      return;
    }
    setBusy(elements.confirmAction, true, "Terminating…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(addOnEndpoint(addOn.code), { method: "DELETE" });
      elements.confirmDialog.close();
      await refreshAddOns();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, "Terminate add-on");
    }
    return;
  }

  const key = state.keys.find((candidate) => candidate.id === state.selectedKeyId);
  if (!key || (mode !== "rotate" && mode !== "revoke")) {
    elements.confirmDialog.close();
    return;
  }

  setBusy(elements.confirmAction, true, mode === "rotate" ? "Rotating…" : "Revoking…");
  elements.confirmError.hidden = true;
  try {
    if (mode === "rotate") {
      const payload = await requestJson(`${keyEndpoint(key.id)}/rotate`, {
        method: "POST",
        body: { api_key: { name: key.name } },
      });
      elements.confirmDialog.close();
      revealOneTimeSecret(payload.api_key.value);
    } else {
      await requestJson(keyEndpoint(key.id), { method: "DELETE" });
      elements.confirmDialog.close();
    }
    await refreshKeys();
  } catch (error) {
    elements.confirmError.textContent = errorMessage(error);
    elements.confirmError.hidden = false;
  } finally {
    setBusy(elements.confirmAction, false, mode === "rotate" ? "Rotate key" : "Revoke key");
  }
}

async function refreshKeys() {
  try {
    const payload = await requestJson(endpoints.apiKeys);
    renderKeys(payload.api_keys);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshSections() {
  try {
    const payload = await requestJson(endpoints.invoiceSections);
    renderSections(payload.invoice_custom_sections);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshTaxes() {
  try {
    const payload = await requestJson(endpoints.taxes);
    renderTaxes(payload.taxes);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshAddOns() {
  try {
    const payload = await requestJson(endpoints.addOns);
    renderAddOns(payload.add_ons);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

function revealOneTimeSecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith("lago_")) {
    showPageError("The operation completed, but the one-time credential was not returned.");
    return;
  }
  state.oneTimeSecret = secret;
  elements.secretValue.textContent = secret;
  elements.copyStatus.textContent = "";
  elements.secretDialog.showModal();
}

async function copyOneTimeSecret() {
  if (!state.oneTimeSecret) return;
  try {
    await navigator.clipboard.writeText(state.oneTimeSecret);
    elements.copyStatus.textContent = "Copied to clipboard.";
    elements.copySecret.textContent = "Copied";
  } catch {
    elements.copyStatus.textContent = "Copy was unavailable. Select and copy the key manually.";
  }
}

function closeSecretDialog() {
  elements.secretDialog.close();
  clearOneTimeSecret();
}

function clearOneTimeSecret() {
  state.oneTimeSecret = null;
  elements.secretValue.textContent = "—";
  elements.copyStatus.textContent = "";
  elements.copySecret.textContent = "Copy key";
}

function showClosedState(error) {
  const code = error instanceof ApiRequestError ? error.code : "operator_unavailable";
  if (code === "operator_access_disabled" || code === "operator_access_misconfigured") {
    elements.closedTitle.textContent = "Operator Access not configured";
    elements.closedMessage.textContent =
      "This isolated operator Worker will not expose billing controls until Cloudflare Access and an active tenant membership are configured.";
  } else if (code === "operator_membership_required") {
    elements.closedTitle.textContent = "Operator membership required";
    elements.closedMessage.textContent =
      "Your Cloudflare Access identity is valid, but it has no active tenant membership for this billing workspace.";
  } else if (code === "operator_unauthorized") {
    elements.closedTitle.textContent = "Valid Access session required";
    elements.closedMessage.textContent =
      "Open this workspace through its protected Cloudflare Access application and authenticate again.";
  } else {
    elements.closedTitle.textContent = "Operator workspace unavailable";
    elements.closedMessage.textContent =
      "The secure operator session could not be established. No billing controls or data have been exposed.";
  }
  elements.workspaceName.textContent = "Access unavailable";
  elements.operatorBadge.hidden = true;
  elements.loading.hidden = true;
  elements.dashboard.hidden = true;
  elements.closed.hidden = false;
}

async function requestJson(path, options = {}) {
  const headers = new Headers({ Accept: "application/json" });
  const request = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    headers.set("X-Operator-Request", "1");
    request.body = JSON.stringify(options.body);
  } else if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("X-Operator-Request", "1");
  }

  const response = await fetch(path, request);
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    if (!response.ok)
      throw new ApiRequestError(response.status, "invalid_response", "Invalid response");
  }
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      safeText(payload.code, "operator_request_failed"),
      safeText(payload.message, `Request failed with status ${response.status}`),
    );
  }
  return payload;
}

class ApiRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

function keyEndpoint(keyId) {
  return `${endpoints.apiKeys}/${encodeURIComponent(keyId)}`;
}

function sectionEndpoint(code) {
  return `${endpoints.invoiceSections}/${encodeURIComponent(code)}`;
}

function taxEndpoint(code) {
  return `${endpoints.taxes}/${encodeURIComponent(code)}`;
}

function addOnEndpoint(code) {
  return `${endpoints.addOns}/${encodeURIComponent(code)}`;
}

function showPageError(message) {
  elements.pageErrorMessage.textContent = message;
  elements.pageError.hidden = false;
}

function hidePageError() {
  elements.pageError.hidden = true;
  elements.pageErrorMessage.textContent = "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "The operator request could not be completed.";
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}

function safeText(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalFormValue(value) {
  const normalized = value.trim();
  return normalized || null;
}

function formValue(value) {
  return typeof value === "string" ? value : "";
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function billingAddress(entity) {
  const locality = [entity.city, entity.state, entity.zipcode].filter(isPresent).join(", ");
  const lines = [entity.address_line1, entity.address_line2, locality, entity.country].filter(
    isPresent,
  );
  return lines.length > 0 ? lines.join(" · ") : "No billing address";
}

function countLabel(value, singular, plural) {
  const count = Array.isArray(value) ? value.length : 0;
  return `${count} ${count === 1 ? singular : plural}`;
}

function isPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function initials(value) {
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
}

function formatDate(value) {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatMoney(amount, currency) {
  const minor = Number(amount);
  const code = safeText(currency, "USD");
  if (!Number.isFinite(minor)) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(
      minor / 100,
    );
  } catch {
    return `${code} ${(minor / 100).toFixed(2)}`;
  }
}
