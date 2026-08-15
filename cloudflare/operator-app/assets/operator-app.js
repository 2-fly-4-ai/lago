const endpoints = {
  session: "/api/operator/v1/session",
  organization: "/api/operator/v1/organization",
  apiKeys: "/api/operator/v1/api-keys",
  invoiceSections: "/api/operator/v1/invoice-custom-sections",
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

void initialize();

async function initialize() {
  try {
    const session = await requestJson(endpoints.session);
    const operator = session.operator;
    state.role = operator.role === "admin" ? "admin" : "viewer";
    const [organizationPayload, keyPayload, sectionsPayload] = await Promise.all([
      requestJson(endpoints.organization),
      requestJson(endpoints.apiKeys),
      requestJson(endpoints.invoiceSections),
    ]);
    renderOperator(operator);
    renderOrganization(organizationPayload.organization);
    renderKeys(keyPayload.api_keys);
    renderSections(sectionsPayload.invoice_custom_sections);
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
  elements.keysEmptyCopy.textContent = isAdmin
    ? "Create a credential when a trusted service needs billing API access."
    : "This organization has no active API credentials. Admin access is required to create one.";
  elements.sectionsEmptyCopy.textContent = isAdmin
    ? "Create a reusable section when invoices need organization-specific content."
    : "This organization has no manual invoice sections. Admin access is required to create one.";
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
