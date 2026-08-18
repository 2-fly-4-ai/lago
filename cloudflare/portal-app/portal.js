const elements = Object.fromEntries(
  [
    "loading",
    "error",
    "error-message",
    "content",
    "organization-name",
    "wallets",
    "usage",
    "customer-info",
    "invoice-summary",
    "invoice-search",
    "invoices",
    "edit-customer",
    "customer-dialog",
    "customer-form",
    "customer-name",
    "customer-email",
    "customer-timezone",
    "form-error",
  ].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]),
);
const state = { token: null, customer: null, invoices: [] };

start();
elements.invoice_search.addEventListener("input", renderInvoices);
elements.edit_customer.addEventListener("click", openCustomerEditor);
elements.customer_form.addEventListener("submit", saveCustomer);
elements.invoices.addEventListener("click", downloadInvoice);

async function start() {
  const match = location.pathname.match(/^\/customer-portal\/([a-f0-9]{64})(?:\/|$)/);
  if (!match) return showError("This customer portal link is invalid.");
  state.token = match[1];
  try {
    const [session, wallets, usage, invoices, overdue] = await Promise.all([
      portalJson("/api/portal/v1/session"),
      portalJson("/api/portal/v1/wallets"),
      portalJson("/api/portal/v1/usage"),
      portalJson("/api/portal/v1/invoices"),
      portalJson("/api/portal/v1/overdue-balances"),
    ]);
    state.customer = session.customer;
    state.invoices = invoices.invoices ?? [];
    elements.organization_name.textContent = session.customer.organization_name;
    renderCards(elements.wallets, wallets.wallets ?? [], (item) => [
      item.name ?? item.code,
      money(item.balance_cents, item.currency),
    ]);
    renderCards(elements.usage, usage.usage ?? [], (item) => [
      item.code,
      `${item.events_count} events`,
    ]);
    renderCustomer();
    renderInvoices();
    elements.invoice_summary.textContent = overdue.overdue_balance?.amount_cents
      ? `${money(overdue.overdue_balance.amount_cents, overdue.overdue_balance.currency)} overdue`
      : "No overdue balance";
    elements.loading.hidden = true;
    elements.content.hidden = false;
  } catch (error) {
    showError(error.message);
  }
}

async function portalJson(path, options = {}) {
  const headers = new Headers({
    Accept: "application/json",
    "X-Customer-Portal-Token": state.token,
  });
  if (options.body) {
    headers.set("Content-Type", "application/json");
    headers.set("X-Portal-Request", "1");
  }
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message ?? "Portal request failed");
  return payload;
}

function renderCards(target, items, values) {
  target.replaceChildren();
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "card";
    const [labelText, valueText] = values(item);
    const label = document.createElement("strong");
    label.textContent = labelText;
    const value = document.createElement("span");
    value.textContent = valueText;
    card.append(label, value);
    target.append(card);
  }
}
function renderCustomer() {
  elements.customer_info.replaceChildren();
  for (const [label, value] of [
    ["Name", state.customer.name],
    ["External ID", state.customer.external_id],
    ["Email", state.customer.email],
    ["Currency", state.customer.currency],
    ["Timezone", state.customer.timezone],
    ["Payment term", `${state.customer.net_payment_term ?? 0} days`],
  ]) {
    const group = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value || "—";
    group.append(dt, dd);
    elements.customer_info.append(group);
  }
}
function renderInvoices() {
  const search = elements.invoice_search.value.trim().toLowerCase();
  elements.invoices.replaceChildren();
  for (const invoice of state.invoices.filter(
    (item) => !search || String(item.number).toLowerCase().includes(search),
  )) {
    const row = document.createElement("tr");
    for (const value of [
      invoice.number,
      invoice.issuing_date ?? invoice.created_at,
      invoice.payment_status,
      money(invoice.total_amount_cents, invoice.currency),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value || "—";
      row.append(cell);
    }
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.className = "text-button";
    button.type = "button";
    button.dataset.invoiceDownload = invoice.lago_id;
    button.textContent = invoice.pdf_status === "ready" ? "Download PDF" : "PDF pending";
    button.disabled = invoice.pdf_status !== "ready";
    action.append(button);
    row.append(action);
    elements.invoices.append(row);
  }
}
async function downloadInvoice(event) {
  const button = event.target.closest("button[data-invoice-download]");
  if (!button) return;
  const response = await fetch(
    `/api/portal/v1/invoices/${encodeURIComponent(button.dataset.invoiceDownload)}/download`,
    { headers: { "X-Customer-Portal-Token": state.token } },
  );
  if (!response.ok) return showError("Invoice PDF could not be downloaded.");
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = "invoice.pdf";
  link.click();
  URL.revokeObjectURL(href);
}
function openCustomerEditor() {
  elements.customer_name.value = state.customer.name ?? "";
  elements.customer_email.value = state.customer.email ?? "";
  elements.customer_timezone.value = state.customer.timezone ?? "";
  elements.form_error.hidden = true;
  elements.customer_dialog.showModal();
}
async function saveCustomer(event) {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  try {
    const payload = await portalJson("/api/portal/v1/session", {
      method: "PATCH",
      body: {
        customer: {
          name: elements.customer_name.value,
          email: elements.customer_email.value,
          timezone: elements.customer_timezone.value,
        },
      },
    });
    state.customer = payload.customer;
    renderCustomer();
    elements.customer_dialog.close();
  } catch (error) {
    elements.form_error.textContent = error.message;
    elements.form_error.hidden = false;
  }
}
function money(cents, currency) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
  }).format((Number(cents) || 0) / 100);
}
function showError(message) {
  elements.loading.hidden = true;
  elements.error_message.textContent = message;
  elements.error.hidden = false;
}
