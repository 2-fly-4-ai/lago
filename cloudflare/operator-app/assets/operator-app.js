import { resolveOriginalRouteAlias } from "./operator-routes.js";

const endpoints = {
  session: "/api/operator/v1/session",
  organization: "/api/operator/v1/organization",
  billingEntity: "/api/operator/v1/billing-entities/default",
  apiKeys: "/api/operator/v1/api-keys",
  invoiceSections: "/api/operator/v1/invoice-custom-sections",
  pricingUnits: "/api/operator/v1/pricing-units",
  alerts: "/api/operator/v1/alerts",
  paymentReceipts: "/api/operator/v1/payment-receipts",
  taxes: "/api/operator/v1/taxes",
  addOns: "/api/operator/v1/add-ons",
  customers: "/api/operator/v1/customers",
  coupons: "/api/operator/v1/coupons",
  appliedCoupons: "/api/operator/v1/applied-coupons",
  plans: "/api/operator/v1/plans",
  subscriptions: "/api/operator/v1/subscriptions",
  invoices: "/api/operator/v1/invoices",
  wallets: "/api/operator/v1/wallets",
  walletTransactions: "/api/operator/v1/wallet-transactions",
  creditNotes: "/api/operator/v1/credit-notes",
  payments: "/api/operator/v1/payments",
  quotes: "/api/operator/v1/quotes",
  quoteVersions: "/api/operator/v1/quote-versions",
  dataExports: "/api/operator/v1/data-exports",
  webhookEndpoints: "/api/operator/v1/webhook-endpoints",
  dunningCampaigns: "/api/operator/v1/dunning-campaigns",
  paymentRequests: "/api/operator/v1/payment-requests",
  analytics: "/api/operator/v1/analytics",
  forecasts: "/api/operator/v1/forecasts",
  billableMetrics: "/api/operator/v1/billable-metrics",
  features: "/api/operator/v1/features",
  aiConversations: "/api/operator/v1/ai/conversations",
  activityLogs: "/api/operator/v1/observability/activity-logs",
  apiLogs: "/api/operator/v1/observability/api-logs",
  events: "/api/operator/v1/observability/events",
  teamMembers: "/api/operator/v1/team/members",
  teamInvitations: "/api/operator/v1/team/invitations",
  teamRoles: "/api/operator/v1/team/roles",
  teamAuthentication: "/api/operator/v1/team/authentication",
  teamSecurityLogs: "/api/operator/v1/team/security-logs",
  integrations: "/api/operator/v1/integrations",
  billingEntityTaxes: "/api/operator/v1/billing-entities/default/taxes",
  billingEntityDunning: "/api/operator/v1/billing-entities/default/dunning-campaign",
  billingEntityLogo: "/api/operator/v1/billing-entities/default/logo",
};

const routeDefinitions = {
  overview: { title: "Organization", group: "Settings" },
  analytics: { title: "Analytics", group: "Reports" },
  forecasts: { title: "Forecasts", group: "Reports" },
  "billable-metrics": { title: "Billable metrics", group: "Configuration" },
  features: { title: "Features", group: "Configuration" },
  plans: { title: "Plans", group: "Configuration" },
  "add-ons": { title: "Add-ons", group: "Configuration" },
  coupons: { title: "Coupons", group: "Configuration" },
  customers: { title: "Customers", group: "Billing & operations" },
  subscriptions: { title: "Subscriptions", group: "Billing & operations" },
  invoices: { title: "Invoices", group: "Billing & operations" },
  payments: { title: "Payments", group: "Billing & operations" },
  "credit-notes": { title: "Credit notes", group: "Billing & operations" },
  wallets: { title: "Wallets", group: "Billing & operations" },
  quotes: { title: "Quotes", group: "Billing & operations" },
  "billing-profile": { title: "Billing profile", group: "Settings" },
  "invoice-sections": { title: "Invoice sections", group: "Settings" },
  "pricing-units": { title: "Pricing units", group: "Settings" },
  taxes: { title: "Taxes", group: "Settings" },
  "api-keys": { title: "API keys", group: "Settings" },
  "payment-receipts": { title: "Payment receipts", group: "Settings" },
  "data-exports": { title: "Data exports", group: "Settings" },
  "webhook-endpoints": { title: "Webhook endpoints", group: "Settings" },
  "dunning-campaigns": { title: "Dunning campaigns", group: "Settings" },
  "activity-logs": { title: "Activity logs", group: "Developer tools" },
  "api-logs": { title: "API logs", group: "Developer tools" },
  events: { title: "Events", group: "Developer tools" },
  "team-security": { title: "Team & security", group: "Settings" },
  integrations: { title: "Integrations", group: "Settings" },
};

const defaultRoute = "customers";
const customerDetailTabs = new Set([
  "overview",
  "wallets",
  "analytics",
  "invoices",
  "credit-notes",
  "settings",
]);

const entityDetailDefinitions = {
  "activity-logs": {
    collection: "activityLogs",
    singular: "Activity log",
    id: (item) => item.lago_id,
    label: (item) => humanize(item.event_type),
    fields: [
      ["Event", (item) => item.event_type],
      ["Resource", (item) => `${item.resource_type} · ${item.resource_id}`],
      ["Version", (item) => item.version],
      ["Delivery", (item) => item.delivery_status],
      ["Changes", (item) => JSON.stringify(item.changes, null, 2)],
      ["Occurred", (item) => formatDate(item.occurred_at)],
    ],
  },
  "api-logs": {
    collection: "apiLogs",
    singular: "API log",
    id: (item) => item.lago_id,
    label: (item) => `${item.method} ${item.path}`,
    fields: [
      ["Request ID", (item) => item.request_id],
      ["Method", (item) => item.method],
      ["Path", (item) => item.path],
      ["Status", (item) => item.status],
      ["Duration", (item) => `${item.duration_ms} ms`],
      ["Request body", (item) => item.request_body],
      ["Response body", (item) => item.response_body],
      ["Occurred", (item) => formatDate(item.occurred_at)],
    ],
  },
  events: {
    collection: "events",
    singular: "Event",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.transaction_id, "Usage event"),
    fields: [
      ["Transaction", (item) => item.transaction_id],
      ["Code", (item) => item.code],
      ["Subscription", (item) => item.external_subscription_id],
      ["Timestamp", (item) => formatDate(item.timestamp)],
      ["Received", (item) => formatDate(item.received_at)],
      ["Properties", (item) => item.properties],
    ],
  },
  "billable-metrics": {
    collection: "billableMetrics",
    singular: "Billable metric",
    id: (item) => item.code,
    label: (item) => safeText(item.name, "Unnamed metric"),
    fields: [
      ["Code", (item) => item.code],
      ["Aggregation", (item) => humanize(item.aggregation_type)],
      ["Event field", (item) => item.field_name],
      ["Recurring", (item) => (item.recurring ? "Yes" : "No")],
      ["Expression", (item) => item.expression],
      ["Description", (item) => item.description],
      ["Activity", (item) => activitySummary(item.activity_logs)],
    ],
    edit: (item) => openEditMetricDialog(item),
  },
  features: {
    collection: "features",
    singular: "Feature",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.name, "Unnamed feature"),
    fields: [
      ["Code", (item) => item.code],
      ["Description", (item) => item.description],
      ["Plans", (item) => item.plans_count],
      ["Active subscriptions", (item) => item.subscriptions_count],
      ["Privileges", (item) => privilegeSummary(item.privileges)],
      ["Created", (item) => formatDate(item.created_at)],
      ["Activity", (item) => activitySummary(item.activity_logs)],
    ],
    edit: (item) => openEditFeatureDialog(item),
  },
  "api-keys": {
    collection: "keys",
    singular: "API key",
    id: (item) => item.id,
    label: (item) => safeText(item.name, "Unnamed key"),
    fields: [
      ["Identifier", (item) => item.id],
      ["Secret", (item) => safeText(item.value, "Masked")],
      ["Created", (item) => formatDate(item.created_at)],
      ["Last used", (item) => (item.last_used_at ? formatDate(item.last_used_at) : "Never")],
    ],
    edit: (item) => openRenameDialog(item),
  },
  "invoice-sections": {
    collection: "sections",
    singular: "Invoice section",
    id: (item) => item.code,
    label: (item) => safeText(item.name, "Unnamed section"),
    fields: [
      ["Code", (item) => item.code],
      ["Display name", (item) => item.display_name],
      ["Description", (item) => item.description],
      ["Details", (item) => item.details],
    ],
    edit: (item) => openEditSectionDialog(item),
  },
  "pricing-units": {
    collection: "pricingUnits",
    singular: "Pricing unit",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.name, "Unnamed pricing unit"),
    fields: [
      ["Code", (item) => item.code],
      ["Short name", (item) => item.short_name],
      ["Description", (item) => item.description],
      ["Updated", (item) => formatDate(item.updated_at)],
    ],
    edit: (item) => openEditPricingUnitDialog(item),
  },
  "payment-receipts": {
    collection: "receipts",
    singular: "Payment receipt",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.number, "Unnamed receipt"),
    fields: [
      ["Identifier", (item) => item.lago_id],
      ["Customer", (item) => item.payment?.external_customer_id],
      ["Invoices", (item) => item.payment?.invoice_numbers],
      ["Amount", (item) => formatMoney(item.payment?.amount_cents, item.payment?.amount_currency)],
      ["Status", (item) => item.payment?.payment_status],
      ["Created", (item) => formatDate(item.created_at)],
    ],
  },
  taxes: {
    collection: "taxes",
    singular: "Tax",
    id: (item) => item.code,
    label: (item) => safeText(item.name, "Unnamed tax"),
    fields: [
      ["Code", (item) => item.code],
      ["Rate", (item) => `${Number(item.rate) || 0}%`],
      ["Description", (item) => item.description],
      ["Organization default", (item) => (item.applied_to_organization ? "Yes" : "No")],
    ],
    edit: (item) => openEditTaxDialog(item),
  },
  "add-ons": {
    collection: "addOns",
    singular: "Add-on",
    id: (item) => item.code,
    label: (item) => safeText(item.name, "Unnamed add-on"),
    fields: [
      ["Code", (item) => item.code],
      ["Amount", (item) => formatMoney(item.amount_cents, item.amount_currency)],
      ["Invoice display name", (item) => item.invoice_display_name],
      ["Description", (item) => item.description],
    ],
    edit: (item) => openEditAddOnDialog(item),
  },
  coupons: {
    collection: "coupons",
    singular: "Coupon",
    id: (item) => item.code,
    label: (item) => safeText(item.name, "Unnamed coupon"),
    fields: [
      ["Code", (item) => item.code],
      ["Discount", (item) => couponDiscount(item)],
      ["Frequency", (item) => couponFrequency(item)],
      [
        "Expiration",
        (item) =>
          item.expiration === "time_limit" ? formatDate(item.expiration_at) : "No expiration",
      ],
      ["Description", (item) => item.description],
    ],
  },
  plans: {
    collection: "plans",
    singular: "Plan",
    id: (item) => item.code,
    label: (item) => safeText(item.name, "Unnamed plan"),
    fields: [
      ["Code", (item) => item.code],
      ["Interval", (item) => item.interval],
      ["Amount", (item) => formatMoney(item.amount_cents, item.amount_currency)],
      ["Trial period", (item) => `${nonNegativeNumber(item.trial_period)} days`],
      ["Fixed charges", (item) => String(item.fixed_charges?.length ?? 0)],
      ["Description", (item) => item.description],
    ],
    edit: (item) => openEditPlanDialog(item),
  },
  subscriptions: {
    collection: "subscriptions",
    singular: "Subscription",
    id: (item) => item.external_id,
    label: (item) => safeText(item.name, item.external_id),
    fields: [
      ["External ID", (item) => item.external_id],
      ["Customer", (item) => item.external_customer_id],
      ["Plan", (item) => item.plan_code],
      ["Status", (item) => item.status],
      ["Billing time", (item) => item.billing_time],
      ["Started", (item) => formatDate(item.subscription_at)],
      ["Ends", (item) => formatDate(item.ending_at)],
    ],
    edit: (item) => openEditSubscriptionDialog(item),
  },
  invoices: {
    collection: "invoices",
    singular: "Invoice",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.number, "Unnumbered invoice"),
    fields: [
      ["Identifier", (item) => item.lago_id],
      ["Customer", (item) => item.external_customer_id],
      ["Status", (item) => item.status],
      ["Payment status", (item) => item.payment_status],
      ["Total", (item) => formatMoney(item.total_amount_cents, item.currency)],
      ["Issued", (item) => formatDate(item.issuing_date ?? item.created_at)],
    ],
  },
  wallets: {
    collection: "wallets",
    singular: "Wallet",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.name, "Unnamed wallet"),
    fields: [
      ["Identifier", (item) => item.lago_id],
      ["Code", (item) => item.code],
      ["Customer", (item) => item.external_customer_id],
      ["Status", (item) => item.status],
      ["Balance", (item) => formatMoney(item.balance_cents, item.currency)],
      ["Credits", (item) => item.credits_balance],
      ["Expires", (item) => formatDate(item.expiration_at)],
    ],
  },
  "credit-notes": {
    collection: "creditNotes",
    singular: "Credit note",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.number, "Unnumbered credit note"),
    fields: [
      ["Identifier", (item) => item.lago_id],
      ["Invoice", (item) => item.invoice_number],
      ["Customer", (item) => item.external_customer_id],
      ["Reason", (item) => item.reason],
      ["Status", (item) => item.status],
      ["Credit status", (item) => item.credit_status],
      ["Balance", (item) => formatMoney(item.balance_amount_cents, item.currency)],
    ],
  },
  payments: {
    collection: "payments",
    singular: "Payment",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.lago_id, "Unknown payment"),
    fields: [
      ["Customer", (item) => item.external_customer_id],
      ["Invoices", (item) => item.invoice_numbers],
      ["Provider", (item) => item.payment_provider_code ?? "Manual"],
      ["Status", (item) => item.payment_status],
      ["Amount", (item) => formatMoney(item.amount_cents, item.amount_currency)],
      ["Created", (item) => formatDate(item.created_at)],
    ],
  },
  quotes: {
    collection: "quotes",
    singular: "Quote",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.number, "Unnumbered quote"),
    fields: [
      ["Identifier", (item) => item.lago_id],
      ["Customer", (item) => item.external_customer_id],
      ["Order type", (item) => item.order_type],
      ["Version", (item) => item.current_version?.version],
      ["Status", (item) => item.current_version?.status],
      ["Updated", (item) => formatDate(item.current_version?.updated_at ?? item.updated_at)],
    ],
    edit: (item) => openEditQuoteDialog(item),
  },
  "data-exports": {
    collection: "dataExports",
    singular: "Data export",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.lago_id, "Unknown export"),
    fields: [
      ["Resource", (item) => item.resource_type],
      ["Status", (item) => item.status],
      ["Rows", (item) => item.row_count],
      ["Size", (item) => (item.byte_size === null ? "—" : `${item.byte_size} bytes`)],
      ["Created", (item) => formatDate(item.created_at)],
      ["Delivery", () => "Status only; artifact download is intentionally unavailable"],
    ],
  },
  "webhook-endpoints": {
    collection: "webhookEndpoints",
    singular: "Webhook endpoint",
    id: (item) => item.lago_id,
    label: (item) => safeText(item.name, item.lago_id),
    fields: [
      ["Identifier", (item) => item.lago_id],
      ["URL", (item) => item.webhook_url],
      ["Signature", (item) => item.signature_algo],
      ["Events", (item) => item.event_types],
      ["Created", (item) => formatDate(item.created_at)],
      ["Delivery logs", (item) => webhookLogSummary(item.webhook_logs)],
      ["Mode", () => "Read only"],
    ],
  },
  "dunning-campaigns": {
    collection: "dunningCampaigns",
    singular: "Dunning campaign",
    id: (item) => item.code,
    label: (item) => safeText(item.name, "Unnamed campaign"),
    fields: [
      ["Code", (item) => item.code],
      ["Attempts", (item) => item.max_attempts],
      ["Days between attempts", (item) => item.days_between_attempts],
      ["Customers", (item) => item.customers_count],
      ["Organization default", (item) => (item.applied_to_organization ? "Yes" : "No")],
      ["Description", (item) => item.description],
    ],
    edit: (item) => openEditDunningDialog(item),
  },
};

const elements = {
  sidebar: document.querySelector(".sidebar"),
  navBurger: document.querySelector("#nav-burger"),
  navigationLinks: Array.from(document.querySelectorAll(".nav-item[data-route]")),
  organizationSwitcher: document.querySelector("#organization-switcher"),
  organizationMenu: document.querySelector("#organization-menu"),
  organizationMenuItems: document.querySelector("#organization-menu-items"),
  switcherMonogram: document.querySelector("#switcher-monogram"),
  switcherName: document.querySelector("#switcher-name"),
  switcherRole: document.querySelector("#switcher-role"),
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
  unavailableRoute: document.querySelector("#unavailable-route"),
  unavailableBreadcrumb: document.querySelector("#unavailable-breadcrumb"),
  unavailableTitle: document.querySelector("#unavailable-title"),
  unavailableMessage: document.querySelector("#unavailable-message"),
  unavailableBoundaryCopy: document.querySelector("#unavailable-boundary-copy"),
  analyticsFrom: document.querySelector("#analytics-from"),
  analyticsTo: document.querySelector("#analytics-to"),
  refreshAnalytics: document.querySelector("#refresh-analytics"),
  analyticsTabs: Array.from(document.querySelectorAll("[data-analytics-tab]")),
  analyticsLoading: document.querySelector("#analytics-loading"),
  analyticsContent: document.querySelector("#analytics-content"),
  analyticsSummary: document.querySelector("#analytics-summary"),
  analyticsCurrency: document.querySelector("#analytics-currency"),
  analyticsChartEyebrow: document.querySelector("#analytics-chart-eyebrow"),
  analyticsChartTitle: document.querySelector("#analytics-chart-title"),
  analyticsChart: document.querySelector("#analytics-chart"),
  analyticsBreakdownTitle: document.querySelector("#analytics-breakdown-title"),
  analyticsBreakdown: document.querySelector("#analytics-breakdown"),
  forecastMonths: document.querySelector("#forecast-months"),
  forecastsLoading: document.querySelector("#forecasts-loading"),
  forecastsContent: document.querySelector("#forecasts-content"),
  forecastChart: document.querySelector("#forecast-chart"),
  forecastTableBody: document.querySelector("#forecast-table-body"),
  forecastMethod: document.querySelector("#forecast-method"),
  openCreateMetric: document.querySelector("#open-create-metric"),
  metricSearch: document.querySelector("#metric-search"),
  metricsLoading: document.querySelector("#metrics-loading"),
  metricsEmpty: document.querySelector("#metrics-empty"),
  metricsTableShell: document.querySelector("#metrics-table-shell"),
  metricsTableBody: document.querySelector("#metrics-table-body"),
  metricFormDialog: document.querySelector("#metric-form-dialog"),
  metricForm: document.querySelector("#metric-form"),
  metricFormTitle: document.querySelector("#metric-form-title"),
  metricName: document.querySelector("#metric-name"),
  metricCode: document.querySelector("#metric-code"),
  metricAggregation: document.querySelector("#metric-aggregation"),
  metricField: document.querySelector("#metric-field"),
  metricDescription: document.querySelector("#metric-description"),
  metricExpression: document.querySelector("#metric-expression"),
  metricRecurring: document.querySelector("#metric-recurring"),
  metricFormError: document.querySelector("#metric-form-error"),
  submitMetricForm: document.querySelector("#submit-metric-form"),
  openCreateFeature: document.querySelector("#open-create-feature"),
  featureSearch: document.querySelector("#feature-search"),
  featuresLoading: document.querySelector("#features-loading"),
  featuresEmpty: document.querySelector("#features-empty"),
  featuresTableShell: document.querySelector("#features-table-shell"),
  featuresTableBody: document.querySelector("#features-table-body"),
  featureFormDialog: document.querySelector("#feature-form-dialog"),
  featureForm: document.querySelector("#feature-form"),
  featureFormTitle: document.querySelector("#feature-form-title"),
  featureName: document.querySelector("#feature-name"),
  featureCode: document.querySelector("#feature-code"),
  featureDescription: document.querySelector("#feature-description"),
  featurePrivileges: document.querySelector("#feature-privileges"),
  addFeaturePrivilege: document.querySelector("#add-feature-privilege"),
  featureFormError: document.querySelector("#feature-form-error"),
  submitFeatureForm: document.querySelector("#submit-feature-form"),
  aiRail: document.querySelector("#ai-rail"),
  openAiPanel: document.querySelector("#open-ai-panel"),
  aiPanel: document.querySelector("#ai-panel"),
  closeAiPanel: document.querySelector("#close-ai-panel"),
  aiHistory: document.querySelector("#ai-history"),
  aiMessages: document.querySelector("#ai-messages"),
  aiShortcuts: document.querySelector("#ai-shortcuts"),
  aiForm: document.querySelector("#ai-form"),
  aiPrompt: document.querySelector("#ai-prompt"),
  sendAiMessage: document.querySelector("#send-ai-message"),
  activityLogsEmpty: document.querySelector("#activity-logs-empty"),
  activityLogsTableShell: document.querySelector("#activity-logs-table-shell"),
  activityLogsTableBody: document.querySelector("#activity-logs-table-body"),
  apiLogsEmpty: document.querySelector("#api-logs-empty"),
  apiLogsTableShell: document.querySelector("#api-logs-table-shell"),
  apiLogsTableBody: document.querySelector("#api-logs-table-body"),
  eventsEmpty: document.querySelector("#events-empty"),
  eventsTableShell: document.querySelector("#events-table-shell"),
  eventsTableBody: document.querySelector("#events-table-body"),
  openTeamInvite: document.querySelector("#open-team-invite"),
  teamMembersBody: document.querySelector("#team-members-body"),
  teamInvitationsBody: document.querySelector("#team-invitations-body"),
  teamAuthentication: document.querySelector("#team-authentication"),
  teamRoles: document.querySelector("#team-roles"),
  teamInviteDialog: document.querySelector("#team-invite-dialog"),
  teamInviteForm: document.querySelector("#team-invite-form"),
  teamInviteEmail: document.querySelector("#team-invite-email"),
  teamInviteRole: document.querySelector("#team-invite-role"),
  teamInviteError: document.querySelector("#team-invite-error"),
  submitTeamInvite: document.querySelector("#submit-team-invite"),
  integrationGroups: document.querySelector("#integration-groups"),
  integrationDialog: document.querySelector("#integration-dialog"),
  integrationForm: document.querySelector("#integration-form"),
  integrationDialogTitle: document.querySelector("#integration-dialog-title"),
  integrationDisplayName: document.querySelector("#integration-display-name"),
  integrationSettings: document.querySelector("#integration-settings"),
  integrationError: document.querySelector("#integration-error"),
  submitIntegration: document.querySelector("#submit-integration"),
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
  billingAdvancedForm: document.querySelector("#billing-advanced-form"),
  billingDefaultTaxes: document.querySelector("#billing-default-taxes"),
  billingDefaultDunning: document.querySelector("#billing-default-dunning"),
  billingLogoFile: document.querySelector("#billing-logo-file"),
  removeBillingLogo: document.querySelector("#remove-billing-logo"),
  saveBillingAdvanced: document.querySelector("#save-billing-advanced"),
  billingAdvancedError: document.querySelector("#billing-advanced-error"),
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
  billingIssuingAdjustment: document.querySelector("#billing-issuing-adjustment"),
  billingIssuingAnchor: document.querySelector("#billing-issuing-anchor"),
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
  openCreatePricingUnit: document.querySelector("#open-create-pricing-unit"),
  pricingUnitsLoading: document.querySelector("#pricing-units-loading"),
  pricingUnitsEmpty: document.querySelector("#pricing-units-empty"),
  pricingUnitsTableShell: document.querySelector("#pricing-units-table-shell"),
  pricingUnitsTableBody: document.querySelector("#pricing-units-table-body"),
  pricingUnitDialog: document.querySelector("#pricing-unit-dialog"),
  pricingUnitForm: document.querySelector("#pricing-unit-form"),
  pricingUnitTitle: document.querySelector("#pricing-unit-title"),
  pricingUnitName: document.querySelector("#pricing-unit-name"),
  pricingUnitCode: document.querySelector("#pricing-unit-code"),
  pricingUnitShortName: document.querySelector("#pricing-unit-short-name"),
  pricingUnitDescription: document.querySelector("#pricing-unit-description"),
  pricingUnitError: document.querySelector("#pricing-unit-error"),
  submitPricingUnit: document.querySelector("#submit-pricing-unit"),
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
  openCreateCustomer: document.querySelector("#open-create-customer"),
  customersLoading: document.querySelector("#customers-loading"),
  customersEmpty: document.querySelector("#customers-empty"),
  customersEmptyCopy: document.querySelector("#customers-empty-copy"),
  customersTableShell: document.querySelector("#customers-table-shell"),
  customersTableBody: document.querySelector("#customers-table-body"),
  customerDetail: document.querySelector("#customer-detail"),
  customerDetailBack: document.querySelector("#customer-detail-back"),
  customerDetailEdit: document.querySelector("#customer-detail-edit"),
  customerPortalLink: document.querySelector("#customer-portal-link"),
  customerDetailEditAside: document.querySelector("#customer-detail-edit-aside"),
  customerDetailAvatar: document.querySelector("#customer-detail-avatar"),
  customerDetailName: document.querySelector("#customer-detail-name"),
  customerDetailExternalId: document.querySelector("#customer-detail-external-id"),
  customerDetailTabs: Array.from(document.querySelectorAll("[data-customer-tab]")),
  customerDetailTabPanel: document.querySelector("#customer-detail-tab-panel"),
  customerDetailFieldName: document.querySelector("#customer-detail-field-name"),
  customerDetailFieldId: document.querySelector("#customer-detail-field-id"),
  customerDetailFieldCurrency: document.querySelector("#customer-detail-field-currency"),
  customerDetailFieldEmail: document.querySelector("#customer-detail-field-email"),
  customerDetailFieldTimezone: document.querySelector("#customer-detail-field-timezone"),
  customerDetailFieldTerm: document.querySelector("#customer-detail-field-term"),
  entityDetail: document.querySelector("#entity-detail"),
  entityDetailBack: document.querySelector("#entity-detail-back"),
  entityDetailBackLabel: document.querySelector("#entity-detail-back-label"),
  entityDetailEdit: document.querySelector("#entity-detail-edit"),
  entityDetailAvatar: document.querySelector("#entity-detail-avatar"),
  entityDetailType: document.querySelector("#entity-detail-type"),
  entityDetailName: document.querySelector("#entity-detail-name"),
  entityDetailId: document.querySelector("#entity-detail-id"),
  entityDetailFields: document.querySelector("#entity-detail-fields"),
  entityDetailMissing: document.querySelector("#entity-detail-missing"),
  entityAlerts: document.querySelector("#entity-alerts"),
  entityAlertsLoading: document.querySelector("#entity-alerts-loading"),
  entityAlertsEmpty: document.querySelector("#entity-alerts-empty"),
  entityAlertsTableShell: document.querySelector("#entity-alerts-table-shell"),
  entityAlertsBody: document.querySelector("#entity-alerts-body"),
  openCreateAlert: document.querySelector("#open-create-alert"),
  alertDialog: document.querySelector("#alert-dialog"),
  alertForm: document.querySelector("#alert-form"),
  alertTitle: document.querySelector("#alert-title"),
  alertName: document.querySelector("#alert-name"),
  alertCode: document.querySelector("#alert-code"),
  alertType: document.querySelector("#alert-type"),
  alertMetric: document.querySelector("#alert-metric"),
  alertThreshold: document.querySelector("#alert-threshold"),
  alertRecurring: document.querySelector("#alert-recurring"),
  alertError: document.querySelector("#alert-error"),
  submitAlert: document.querySelector("#submit-alert"),
  customerFormDialog: document.querySelector("#customer-form-dialog"),
  customerForm: document.querySelector("#customer-form"),
  customerFormTitle: document.querySelector("#customer-form-title"),
  customerFormCopy: document.querySelector("#customer-form-copy"),
  customerExternalId: document.querySelector("#customer-external-id"),
  customerName: document.querySelector("#customer-name"),
  customerEmail: document.querySelector("#customer-email"),
  customerCurrency: document.querySelector("#customer-currency"),
  customerTimezone: document.querySelector("#customer-timezone"),
  customerNetTerm: document.querySelector("#customer-net-term"),
  customerGracePeriod: document.querySelector("#customer-grace-period"),
  customerFormError: document.querySelector("#customer-form-error"),
  submitCustomerForm: document.querySelector("#submit-customer-form"),
  openCreateCoupon: document.querySelector("#open-create-coupon"),
  openApplyCoupon: document.querySelector("#open-apply-coupon"),
  couponsLoading: document.querySelector("#coupons-loading"),
  couponsEmpty: document.querySelector("#coupons-empty"),
  couponsEmptyCopy: document.querySelector("#coupons-empty-copy"),
  couponsTableShell: document.querySelector("#coupons-table-shell"),
  couponsTableBody: document.querySelector("#coupons-table-body"),
  appliedCouponsLoading: document.querySelector("#applied-coupons-loading"),
  appliedCouponsEmpty: document.querySelector("#applied-coupons-empty"),
  appliedCouponsTableShell: document.querySelector("#applied-coupons-table-shell"),
  appliedCouponsTableBody: document.querySelector("#applied-coupons-table-body"),
  couponFormDialog: document.querySelector("#coupon-form-dialog"),
  couponForm: document.querySelector("#coupon-form"),
  couponName: document.querySelector("#coupon-name"),
  couponCode: document.querySelector("#coupon-code"),
  couponType: document.querySelector("#coupon-type"),
  couponPercentage: document.querySelector("#coupon-percentage"),
  couponAmount: document.querySelector("#coupon-amount"),
  couponCurrency: document.querySelector("#coupon-currency"),
  couponFrequency: document.querySelector("#coupon-frequency"),
  couponDuration: document.querySelector("#coupon-duration"),
  couponExpiration: document.querySelector("#coupon-expiration"),
  couponExpirationAt: document.querySelector("#coupon-expiration-at"),
  couponDescription: document.querySelector("#coupon-description"),
  couponReusable: document.querySelector("#coupon-reusable"),
  couponFormError: document.querySelector("#coupon-form-error"),
  submitCouponForm: document.querySelector("#submit-coupon-form"),
  applyCouponDialog: document.querySelector("#apply-coupon-dialog"),
  applyCouponForm: document.querySelector("#apply-coupon-form"),
  applyCouponCustomer: document.querySelector("#apply-coupon-customer"),
  applyCouponCode: document.querySelector("#apply-coupon-code"),
  applyCouponError: document.querySelector("#apply-coupon-error"),
  submitApplyCoupon: document.querySelector("#submit-apply-coupon"),
  openCreatePlan: document.querySelector("#open-create-plan"),
  openCreateFixedCharge: document.querySelector("#open-create-fixed-charge"),
  plansLoading: document.querySelector("#plans-loading"),
  plansEmpty: document.querySelector("#plans-empty"),
  plansEmptyCopy: document.querySelector("#plans-empty-copy"),
  plansTableShell: document.querySelector("#plans-table-shell"),
  plansTableBody: document.querySelector("#plans-table-body"),
  fixedChargesEmpty: document.querySelector("#fixed-charges-empty"),
  fixedChargesTableShell: document.querySelector("#fixed-charges-table-shell"),
  fixedChargesTableBody: document.querySelector("#fixed-charges-table-body"),
  planFormDialog: document.querySelector("#plan-form-dialog"),
  planForm: document.querySelector("#plan-form"),
  planFormTitle: document.querySelector("#plan-form-title"),
  planFormCopy: document.querySelector("#plan-form-copy"),
  planName: document.querySelector("#plan-name"),
  planCode: document.querySelector("#plan-code"),
  planInterval: document.querySelector("#plan-interval"),
  planAmount: document.querySelector("#plan-amount"),
  planCurrency: document.querySelector("#plan-currency"),
  planTrial: document.querySelector("#plan-trial"),
  planInvoiceName: document.querySelector("#plan-invoice-name"),
  planDescription: document.querySelector("#plan-description"),
  planPayAdvance: document.querySelector("#plan-pay-advance"),
  planEntitlements: document.querySelector("#plan-entitlements"),
  planEntitlementsEmpty: document.querySelector("#plan-entitlements-empty"),
  planFormError: document.querySelector("#plan-form-error"),
  submitPlanForm: document.querySelector("#submit-plan-form"),
  fixedChargeFormDialog: document.querySelector("#fixed-charge-form-dialog"),
  fixedChargeForm: document.querySelector("#fixed-charge-form"),
  fixedChargeFormTitle: document.querySelector("#fixed-charge-form-title"),
  fixedChargePlan: document.querySelector("#fixed-charge-plan"),
  fixedChargeAddOn: document.querySelector("#fixed-charge-add-on"),
  fixedChargeCode: document.querySelector("#fixed-charge-code"),
  fixedChargeModel: document.querySelector("#fixed-charge-model"),
  fixedChargeUnits: document.querySelector("#fixed-charge-units"),
  fixedChargeInvoiceName: document.querySelector("#fixed-charge-invoice-name"),
  fixedChargeProperties: document.querySelector("#fixed-charge-properties"),
  fixedChargePayAdvance: document.querySelector("#fixed-charge-pay-advance"),
  fixedChargeProrated: document.querySelector("#fixed-charge-prorated"),
  fixedChargeApplyNow: document.querySelector("#fixed-charge-apply-now"),
  fixedChargeFormError: document.querySelector("#fixed-charge-form-error"),
  submitFixedChargeForm: document.querySelector("#submit-fixed-charge-form"),
  openCreateSubscription: document.querySelector("#open-create-subscription"),
  subscriptionsLoading: document.querySelector("#subscriptions-loading"),
  subscriptionsEmpty: document.querySelector("#subscriptions-empty"),
  subscriptionsEmptyCopy: document.querySelector("#subscriptions-empty-copy"),
  subscriptionsTableShell: document.querySelector("#subscriptions-table-shell"),
  subscriptionsTableBody: document.querySelector("#subscriptions-table-body"),
  subscriptionFormDialog: document.querySelector("#subscription-form-dialog"),
  subscriptionForm: document.querySelector("#subscription-form"),
  subscriptionFormTitle: document.querySelector("#subscription-form-title"),
  subscriptionFormCopy: document.querySelector("#subscription-form-copy"),
  subscriptionExternalId: document.querySelector("#subscription-external-id"),
  subscriptionCustomer: document.querySelector("#subscription-customer"),
  subscriptionPlan: document.querySelector("#subscription-plan"),
  subscriptionName: document.querySelector("#subscription-name"),
  subscriptionAt: document.querySelector("#subscription-at"),
  subscriptionEndingAt: document.querySelector("#subscription-ending-at"),
  subscriptionBillingTime: document.querySelector("#subscription-billing-time"),
  subscriptionTerminationInvoice: document.querySelector("#subscription-termination-invoice"),
  subscriptionTerminationCredit: document.querySelector("#subscription-termination-credit"),
  subscriptionFormError: document.querySelector("#subscription-form-error"),
  submitSubscriptionForm: document.querySelector("#submit-subscription-form"),
  terminateSubscriptionDialog: document.querySelector("#terminate-subscription-dialog"),
  terminateSubscriptionForm: document.querySelector("#terminate-subscription-form"),
  terminateSubscriptionCopy: document.querySelector("#terminate-subscription-copy"),
  terminateSubscriptionInvoice: document.querySelector("#terminate-subscription-invoice"),
  terminateSubscriptionCredit: document.querySelector("#terminate-subscription-credit"),
  terminateSubscriptionError: document.querySelector("#terminate-subscription-error"),
  submitTerminateSubscription: document.querySelector("#submit-terminate-subscription"),
  openCreateInvoice: document.querySelector("#open-create-invoice"),
  invoicesLoading: document.querySelector("#invoices-loading"),
  invoicesEmpty: document.querySelector("#invoices-empty"),
  invoicesEmptyCopy: document.querySelector("#invoices-empty-copy"),
  invoicesTableShell: document.querySelector("#invoices-table-shell"),
  invoicesTableBody: document.querySelector("#invoices-table-body"),
  invoiceFormDialog: document.querySelector("#invoice-form-dialog"),
  invoiceForm: document.querySelector("#invoice-form"),
  invoiceCustomer: document.querySelector("#invoice-customer"),
  invoiceCurrency: document.querySelector("#invoice-currency"),
  invoiceFees: document.querySelector("#invoice-fees"),
  invoiceFormError: document.querySelector("#invoice-form-error"),
  submitInvoiceForm: document.querySelector("#submit-invoice-form"),
  openCreateWallet: document.querySelector("#open-create-wallet"),
  walletsLoading: document.querySelector("#wallets-loading"),
  walletsEmpty: document.querySelector("#wallets-empty"),
  walletsEmptyCopy: document.querySelector("#wallets-empty-copy"),
  walletsTableShell: document.querySelector("#wallets-table-shell"),
  walletsTableBody: document.querySelector("#wallets-table-body"),
  walletFormDialog: document.querySelector("#wallet-form-dialog"),
  walletForm: document.querySelector("#wallet-form"),
  walletCustomer: document.querySelector("#wallet-customer"),
  walletName: document.querySelector("#wallet-name"),
  walletCode: document.querySelector("#wallet-code"),
  walletCurrency: document.querySelector("#wallet-currency"),
  walletRate: document.querySelector("#wallet-rate"),
  walletCredits: document.querySelector("#wallet-credits"),
  walletPriority: document.querySelector("#wallet-priority"),
  walletExpiration: document.querySelector("#wallet-expiration"),
  walletFormError: document.querySelector("#wallet-form-error"),
  submitWalletForm: document.querySelector("#submit-wallet-form"),
  walletTopUpDialog: document.querySelector("#wallet-top-up-dialog"),
  walletTopUpForm: document.querySelector("#wallet-top-up-form"),
  walletTopUpCredits: document.querySelector("#wallet-top-up-credits"),
  walletTopUpName: document.querySelector("#wallet-top-up-name"),
  walletTopUpError: document.querySelector("#wallet-top-up-error"),
  submitWalletTopUp: document.querySelector("#submit-wallet-top-up"),
  openCreateCreditNote: document.querySelector("#open-create-credit-note"),
  creditNotesLoading: document.querySelector("#credit-notes-loading"),
  creditNotesEmpty: document.querySelector("#credit-notes-empty"),
  creditNotesEmptyCopy: document.querySelector("#credit-notes-empty-copy"),
  creditNotesTableShell: document.querySelector("#credit-notes-table-shell"),
  creditNotesTableBody: document.querySelector("#credit-notes-table-body"),
  creditNoteFormDialog: document.querySelector("#credit-note-form-dialog"),
  creditNoteForm: document.querySelector("#credit-note-form"),
  creditNoteInvoice: document.querySelector("#credit-note-invoice"),
  creditNoteReason: document.querySelector("#credit-note-reason"),
  creditNoteAmount: document.querySelector("#credit-note-amount"),
  creditNoteDescription: document.querySelector("#credit-note-description"),
  creditNoteItems: document.querySelector("#credit-note-items"),
  creditNoteFormError: document.querySelector("#credit-note-form-error"),
  submitCreditNoteForm: document.querySelector("#submit-credit-note-form"),
  paymentsLoading: document.querySelector("#payments-loading"),
  paymentsEmpty: document.querySelector("#payments-empty"),
  paymentsTableShell: document.querySelector("#payments-table-shell"),
  paymentsTableBody: document.querySelector("#payments-table-body"),
  openCreateQuote: document.querySelector("#open-create-quote"),
  quotesLoading: document.querySelector("#quotes-loading"),
  quotesEmpty: document.querySelector("#quotes-empty"),
  quotesEmptyCopy: document.querySelector("#quotes-empty-copy"),
  quotesTableShell: document.querySelector("#quotes-table-shell"),
  quotesTableBody: document.querySelector("#quotes-table-body"),
  quoteFormDialog: document.querySelector("#quote-form-dialog"),
  quoteForm: document.querySelector("#quote-form"),
  quoteFormTitle: document.querySelector("#quote-form-title"),
  quoteFormCopy: document.querySelector("#quote-form-copy"),
  quoteCustomer: document.querySelector("#quote-customer"),
  quoteOrderType: document.querySelector("#quote-order-type"),
  quoteSubscription: document.querySelector("#quote-subscription"),
  quoteContent: document.querySelector("#quote-content"),
  quoteBillingItems: document.querySelector("#quote-billing-items"),
  quoteFormError: document.querySelector("#quote-form-error"),
  submitQuoteForm: document.querySelector("#submit-quote-form"),
  openCreateDataExport: document.querySelector("#open-create-data-export"),
  dataExportsLoading: document.querySelector("#data-exports-loading"),
  dataExportsEmpty: document.querySelector("#data-exports-empty"),
  dataExportsEmptyCopy: document.querySelector("#data-exports-empty-copy"),
  dataExportsTableShell: document.querySelector("#data-exports-table-shell"),
  dataExportsTableBody: document.querySelector("#data-exports-table-body"),
  dataExportFormDialog: document.querySelector("#data-export-form-dialog"),
  dataExportForm: document.querySelector("#data-export-form"),
  dataExportResource: document.querySelector("#data-export-resource"),
  dataExportFilters: document.querySelector("#data-export-filters"),
  dataExportFormError: document.querySelector("#data-export-form-error"),
  submitDataExportForm: document.querySelector("#submit-data-export-form"),
  webhookEndpointsLoading: document.querySelector("#webhook-endpoints-loading"),
  webhookEndpointsEmpty: document.querySelector("#webhook-endpoints-empty"),
  webhookEndpointsTableShell: document.querySelector("#webhook-endpoints-table-shell"),
  webhookEndpointsTableBody: document.querySelector("#webhook-endpoints-table-body"),
  openCreateDunning: document.querySelector("#open-create-dunning"),
  dunningLoading: document.querySelector("#dunning-loading"),
  dunningEmpty: document.querySelector("#dunning-empty"),
  dunningTableShell: document.querySelector("#dunning-table-shell"),
  dunningTableBody: document.querySelector("#dunning-table-body"),
  paymentRequestsLoading: document.querySelector("#payment-requests-loading"),
  paymentRequestsEmpty: document.querySelector("#payment-requests-empty"),
  paymentRequestsTableShell: document.querySelector("#payment-requests-table-shell"),
  paymentRequestsTableBody: document.querySelector("#payment-requests-table-body"),
  dunningFormDialog: document.querySelector("#dunning-form-dialog"),
  dunningForm: document.querySelector("#dunning-form"),
  dunningFormTitle: document.querySelector("#dunning-form-title"),
  dunningName: document.querySelector("#dunning-name"),
  dunningCode: document.querySelector("#dunning-code"),
  dunningDays: document.querySelector("#dunning-days"),
  dunningAttempts: document.querySelector("#dunning-attempts"),
  dunningDescription: document.querySelector("#dunning-description"),
  dunningThresholds: document.querySelector("#dunning-thresholds"),
  dunningBcc: document.querySelector("#dunning-bcc"),
  dunningApplied: document.querySelector("#dunning-applied"),
  dunningFormError: document.querySelector("#dunning-form-error"),
  submitDunningForm: document.querySelector("#submit-dunning-form"),
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
  secretTitle: document.querySelector("#secret-title"),
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
  entityAdvanced: document.querySelector("#entity-advanced"),
  entityAdvancedTitle: document.querySelector("#entity-advanced-title"),
  entityAdvancedCopy: document.querySelector("#entity-advanced-copy"),
  entityAdvancedContent: document.querySelector("#entity-advanced-content"),
  entityDownloadDocument: document.querySelector("#entity-download-document"),
};

const state = {
  organizationSlug: null,
  memberships: [],
  route: defaultRoute,
  detailId: null,
  detailTab: "overview",
  role: "viewer",
  currentMembershipId: null,
  keys: [],
  keyFormMode: "create",
  selectedKeyId: null,
  confirmMode: null,
  oneTimeSecret: null,
  sections: [],
  pricingUnits: [],
  pricingUnitFormMode: "create",
  selectedPricingUnitId: null,
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
  customers: [],
  customerFormMode: "create",
  selectedCustomerExternalId: null,
  coupons: [],
  appliedCoupons: [],
  selectedAppliedCouponId: null,
  plans: [],
  planFormMode: "create",
  selectedPlanCode: null,
  fixedChargeFormMode: "create",
  selectedFixedChargeCode: null,
  subscriptions: [],
  subscriptionFormMode: "create",
  selectedSubscriptionExternalId: null,
  invoices: [],
  selectedInvoiceId: null,
  wallets: [],
  selectedWalletId: null,
  creditNotes: [],
  selectedCreditNoteId: null,
  payments: [],
  quotes: [],
  quoteFormMode: "create",
  selectedQuoteId: null,
  selectedQuoteVersionId: null,
  dataExports: [],
  webhookEndpoints: [],
  dunningCampaigns: [],
  paymentRequests: [],
  dunningFormMode: "create",
  selectedDunningCode: null,
  analytics: null,
  analyticsTab: "revenue",
  analyticsMetricCode: null,
  forecast: null,
  billableMetrics: [],
  metricFormMode: "create",
  selectedMetricCode: null,
  features: [],
  featureFormMode: "create",
  selectedFeatureId: null,
  aiConversations: [],
  activeAiConversationId: null,
  aiMessages: [],
  activityLogs: [],
  apiLogs: [],
  events: [],
  teamMembers: [],
  teamInvitations: [],
  teamRoles: [],
  teamAuthentication: null,
  integrations: [],
  selectedIntegrationCode: null,
  entityAlerts: [],
  alertFormMode: "create",
  selectedAlertId: null,
};

for (const link of elements.navigationLinks) link.addEventListener("click", handleRouteNavigation);
elements.navBurger.addEventListener("click", toggleMobileNavigation);
elements.organizationSwitcher.addEventListener("click", toggleOrganizationMenu);
elements.organizationMenuItems.addEventListener("click", handleOrganizationSelection);
window.addEventListener("popstate", handleHistoryNavigation);
document.addEventListener("click", closeOrganizationMenuOnOutsideClick);
document.addEventListener("keydown", handleGlobalEscape);
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
elements.openCreatePricingUnit.addEventListener("click", openCreatePricingUnitDialog);
elements.pricingUnitsTableBody.addEventListener("click", handlePricingUnitAction);
elements.pricingUnitForm.addEventListener("submit", submitPricingUnitForm);
elements.openEditBilling.addEventListener("click", openBillingDialog);
elements.billingForm.addEventListener("submit", submitBillingForm);
elements.billingAdvancedForm.addEventListener("submit", submitBillingAdvanced);
elements.removeBillingLogo.addEventListener("click", removeBillingLogo);
elements.openCreateTax.addEventListener("click", openCreateTaxDialog);
elements.taxesTableBody.addEventListener("click", handleTaxAction);
elements.taxForm.addEventListener("submit", submitTaxForm);
elements.openCreateAddOn.addEventListener("click", openCreateAddOnDialog);
elements.addOnsTableBody.addEventListener("click", handleAddOnAction);
elements.addOnForm.addEventListener("submit", submitAddOnForm);
elements.openCreateCustomer.addEventListener("click", openCreateCustomerDialog);
elements.customersTableBody.addEventListener("click", handleCustomerAction);
elements.customerDetailBack.addEventListener("click", () => navigateToRoute("customers"));
elements.customerDetailEdit.addEventListener("click", openSelectedCustomerEditor);
elements.customerPortalLink.addEventListener("click", createCustomerPortalLink);
elements.customerDetailEditAside.addEventListener("click", openSelectedCustomerEditor);
for (const tab of elements.customerDetailTabs) tab.addEventListener("click", handleCustomerTab);
elements.entityDetailBack.addEventListener("click", () => navigateToRoute(state.route));
elements.entityDetailEdit.addEventListener("click", openSelectedEntityEditor);
elements.entityDownloadDocument.addEventListener("click", downloadSelectedDocument);
elements.openCreateAlert.addEventListener("click", openCreateAlertDialog);
elements.entityAlertsBody.addEventListener("click", handleAlertAction);
elements.alertForm.addEventListener("submit", submitAlertForm);
elements.dashboard.addEventListener("click", handleEntityDetailNavigation);
elements.customerForm.addEventListener("submit", submitCustomerForm);
elements.openCreateCoupon.addEventListener("click", openCreateCouponDialog);
elements.openApplyCoupon.addEventListener("click", openApplyCouponDialog);
elements.couponForm.addEventListener("submit", submitCouponForm);
elements.applyCouponForm.addEventListener("submit", submitApplyCouponForm);
elements.appliedCouponsTableBody.addEventListener("click", handleAppliedCouponAction);
elements.openCreatePlan.addEventListener("click", openCreatePlanDialog);
elements.openCreateFixedCharge.addEventListener("click", openCreateFixedChargeDialog);
elements.plansTableBody.addEventListener("click", handlePlanAction);
elements.fixedChargesTableBody.addEventListener("click", handleFixedChargeAction);
elements.planForm.addEventListener("submit", submitPlanForm);
elements.fixedChargeForm.addEventListener("submit", submitFixedChargeForm);
elements.openCreateSubscription.addEventListener("click", openCreateSubscriptionDialog);
elements.subscriptionsTableBody.addEventListener("click", handleSubscriptionAction);
elements.subscriptionForm.addEventListener("submit", submitSubscriptionForm);
elements.terminateSubscriptionForm.addEventListener("submit", submitTerminateSubscription);
elements.openCreateInvoice.addEventListener("click", openCreateInvoiceDialog);
elements.invoicesTableBody.addEventListener("click", handleInvoiceAction);
elements.invoiceForm.addEventListener("submit", submitInvoiceForm);
elements.openCreateWallet.addEventListener("click", openCreateWalletDialog);
elements.walletsTableBody.addEventListener("click", handleWalletAction);
elements.walletForm.addEventListener("submit", submitWalletForm);
elements.walletTopUpForm.addEventListener("submit", submitWalletTopUp);
elements.openCreateCreditNote.addEventListener("click", openCreateCreditNoteDialog);
elements.creditNotesTableBody.addEventListener("click", handleCreditNoteAction);
elements.creditNoteForm.addEventListener("submit", submitCreditNoteForm);
elements.openCreateQuote.addEventListener("click", openCreateQuoteDialog);
elements.quotesTableBody.addEventListener("click", handleQuoteAction);
elements.quoteForm.addEventListener("submit", submitQuoteForm);
elements.openCreateDataExport.addEventListener("click", openCreateDataExportDialog);
elements.dataExportForm.addEventListener("submit", submitDataExportForm);
elements.openCreateDunning.addEventListener("click", openCreateDunningDialog);
elements.dunningTableBody.addEventListener("click", handleDunningAction);
elements.dunningForm.addEventListener("submit", submitDunningForm);
elements.refreshAnalytics.addEventListener("click", refreshAnalytics);
for (const tab of elements.analyticsTabs) tab.addEventListener("click", selectAnalyticsTab);
elements.forecastMonths.addEventListener("change", refreshForecasts);
elements.openCreateMetric.addEventListener("click", openCreateMetricDialog);
elements.metricSearch.addEventListener("input", renderBillableMetrics);
elements.metricsTableBody.addEventListener("click", handleMetricAction);
elements.metricForm.addEventListener("submit", submitMetricForm);
elements.openCreateFeature.addEventListener("click", openCreateFeatureDialog);
elements.featureSearch.addEventListener("input", renderFeatures);
elements.featuresTableBody.addEventListener("click", handleFeatureAction);
elements.featureForm.addEventListener("submit", submitFeatureForm);
elements.addFeaturePrivilege.addEventListener("click", () => addPrivilegeEditor());
elements.featurePrivileges.addEventListener("click", removePrivilegeEditor);
elements.openAiPanel.addEventListener("click", openAiPanel);
elements.closeAiPanel.addEventListener("click", closeAiPanel);
elements.aiHistory.addEventListener("click", selectAiConversation);
elements.aiShortcuts.addEventListener("click", useAiShortcut);
elements.aiForm.addEventListener("submit", submitAiMessage);
elements.openTeamInvite.addEventListener("click", openTeamInviteDialog);
elements.teamInviteForm.addEventListener("submit", submitTeamInvitation);
elements.integrationGroups.addEventListener("click", handleIntegrationAction);
elements.integrationForm.addEventListener("submit", submitIntegrationConfiguration);
elements.teamMembersBody.addEventListener("change", updateTeamMemberRole);
elements.teamMembersBody.addEventListener("click", revokeTeamMember);
elements.teamInvitationsBody.addEventListener("change", updateTeamInvitationRole);
elements.teamInvitationsBody.addEventListener("click", revokeTeamInvitation);

void initialize();

async function initialize() {
  const locationState = routeFromLocation();
  state.route = locationState.route;
  state.organizationSlug = locationState.organizationSlug;
  state.detailId = locationState.detailId;
  state.detailTab = locationState.detailTab;
  state.analyticsTab = locationState.analyticsTab;
  state.analyticsMetricCode = locationState.analyticsMetricCode;
  await loadWorkspace({ replaceHistory: true });
}

async function loadWorkspace({ replaceHistory = false } = {}) {
  elements.closed.hidden = true;
  elements.dashboard.hidden = true;
  elements.loading.hidden = false;
  closeOrganizationMenu();
  clearOneTimeSecret();
  try {
    const session = await requestJson(endpoints.session);
    const operator = session.operator;
    state.organizationSlug = safeText(
      operator.organization_slug,
      operator.organization_external_id,
    );
    state.memberships = Array.isArray(operator.memberships) ? operator.memberships : [];
    state.role = operator.role === "admin" ? "admin" : "viewer";
    const [
      organizationPayload,
      billingPayload,
      keyPayload,
      sectionsPayload,
      pricingUnitsPayload,
      receiptsPayload,
      taxesPayload,
      addOnsPayload,
      customersPayload,
      couponsPayload,
      appliedCouponsPayload,
      plansPayload,
      subscriptionsPayload,
      invoicesPayload,
      walletsPayload,
      creditNotesPayload,
      paymentsPayload,
      quotesPayload,
      dataExportsPayload,
      webhookEndpointsPayload,
      dunningCampaignsPayload,
      paymentRequestsPayload,
      analyticsPayload,
      forecastPayload,
      metricsPayload,
      featuresPayload,
      aiPayload,
      activityLogsPayload,
      apiLogsPayload,
      eventsPayload,
      teamMembersPayload,
      teamInvitationsPayload,
      teamRolesPayload,
      teamAuthenticationPayload,
      integrationsPayload,
    ] = await Promise.all([
      requestJson(endpoints.organization),
      requestJson(endpoints.billingEntity),
      requestJson(endpoints.apiKeys),
      requestJson(endpoints.invoiceSections),
      requestJson(endpoints.pricingUnits),
      requestJson(endpoints.paymentReceipts),
      requestJson(endpoints.taxes),
      requestJson(endpoints.addOns),
      requestJson(endpoints.customers),
      requestJson(endpoints.coupons),
      requestJson(endpoints.appliedCoupons),
      requestJson(endpoints.plans),
      requestJson(endpoints.subscriptions),
      requestJson(endpoints.invoices),
      requestJson(endpoints.wallets),
      requestJson(endpoints.creditNotes),
      requestJson(endpoints.payments),
      requestJson(endpoints.quotes),
      requestJson(endpoints.dataExports),
      requestJson(endpoints.webhookEndpoints),
      requestJson(endpoints.dunningCampaigns),
      requestJson(endpoints.paymentRequests),
      requestJson(
        state.analyticsMetricCode
          ? `${endpoints.analytics}?billable_metric_code=${encodeURIComponent(state.analyticsMetricCode)}`
          : endpoints.analytics,
      ),
      requestJson(endpoints.forecasts),
      requestJson(endpoints.billableMetrics),
      requestJson(endpoints.features),
      requestJson(`${endpoints.aiConversations}?limit=3`),
      requestJson(endpoints.activityLogs),
      requestJson(endpoints.apiLogs),
      requestJson(endpoints.events),
      requestJson(endpoints.teamMembers),
      requestJson(endpoints.teamInvitations),
      requestJson(endpoints.teamRoles),
      requestJson(endpoints.teamAuthentication),
      requestJson(endpoints.integrations),
    ]);
    renderOperator(operator);
    renderOrganization(organizationPayload.organization);
    renderBillingEntity(billingPayload.billing_entity);
    renderKeys(keyPayload.api_keys);
    renderSections(sectionsPayload.invoice_custom_sections);
    renderPricingUnits(pricingUnitsPayload.pricing_units);
    renderReceipts(receiptsPayload.payment_receipts);
    renderTaxes(taxesPayload.taxes);
    renderAddOns(addOnsPayload.add_ons);
    renderCustomers(customersPayload.customers);
    renderCoupons(couponsPayload.coupons);
    renderAppliedCoupons(appliedCouponsPayload.applied_coupons);
    renderPlans(plansPayload.plans);
    renderSubscriptions(subscriptionsPayload.subscriptions);
    renderInvoices(invoicesPayload.invoices);
    renderWallets(walletsPayload.wallets);
    renderCreditNotes(creditNotesPayload.credit_notes);
    renderPayments(paymentsPayload.payments);
    renderQuotes(quotesPayload.quotes);
    renderDataExports(dataExportsPayload.data_exports);
    renderWebhookEndpoints(webhookEndpointsPayload.webhook_endpoints);
    renderDunningCampaigns(dunningCampaignsPayload.dunning_campaigns);
    renderPaymentRequests(paymentRequestsPayload.payment_requests);
    renderAnalytics(analyticsPayload.analytics);
    renderForecasts(forecastPayload.forecast);
    renderBillableMetrics(metricsPayload.billable_metrics);
    renderFeatures(featuresPayload.features);
    renderAiHistory(aiPayload.conversations);
    renderAiMessages();
    renderObservability(
      activityLogsPayload.activity_logs,
      apiLogsPayload.api_logs,
      eventsPayload.events,
    );
    renderTeamSecurity(
      teamMembersPayload.members,
      teamInvitationsPayload.invitations,
      teamRolesPayload.roles,
      teamAuthenticationPayload.authentication,
    );
    renderIntegrations(integrationsPayload.integrations);
    await renderBillingAdvanced();
    elements.aiRail.hidden = false;
    await hydrateSelectedCatalogDetail();
    renderOrganizationMenu();
    renderRoute({ replaceHistory });
    elements.loading.hidden = true;
    elements.dashboard.hidden = false;
  } catch (error) {
    showClosedState(error);
  }
}

function routeFromLocation() {
  const segments = window.location.pathname.split("/").filter(Boolean).map(decodePathSegment);
  const legacyHash = window.location.hash.replace(/^#/, "");
  let organizationSlug = null;
  let route = defaultRoute;
  let detailId = null;
  let detailTab = "overview";
  let analyticsTab = "revenue";
  let analyticsMetricCode = null;

  const originalRoute = resolveOriginalRouteAlias(segments);
  if (originalRoute) {
    organizationSlug = originalRoute.organizationSlug;
    route = originalRoute.route;
    detailId = originalRoute.detailId ?? null;
    detailTab = originalRoute.detailTab ?? "overview";
    analyticsTab = originalRoute.analyticsTab ?? "revenue";
    analyticsMetricCode = originalRoute.analyticsMetricCode ?? null;
    return {
      organizationSlug,
      route,
      detailId,
      detailTab,
      analyticsTab,
      analyticsMetricCode,
    };
  }

  if (segments.length >= 2) {
    [organizationSlug, route] = segments;
    if (route === "analytics-v2") route = "analytics";
    if ((route === "customers" || entityDetailDefinitions[route]) && segments[2]) {
      detailId = segments[2];
    }
    if (route === "customers" && customerDetailTabs.has(segments[3])) detailTab = segments[3];
    if (route === "analytics") {
      const requestedTab = segments[2];
      const tabAliases = { prepaid_credits: "credits", revenue_streams: "revenue" };
      const normalizedTab = tabAliases[requestedTab] ?? requestedTab;
      if (new Set(["revenue", "mrr", "usage", "credits", "invoices"]).has(normalizedTab)) {
        analyticsTab = normalizedTab;
      }
      if (normalizedTab === "usage" && segments[3]) analyticsMetricCode = segments[3];
    }
  } else if (segments.length === 1) {
    if (routeDefinitions[segments[0]]) route = segments[0];
    else organizationSlug = segments[0];
  }
  if (routeDefinitions[legacyHash]) route = legacyHash;

  return {
    organizationSlug,
    route: routeDefinitions[route] ? route : "not-found",
    detailId,
    detailTab,
    analyticsTab,
    analyticsMetricCode,
  };
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

function routePath(organizationSlug, route, detailId = null, detailTab = null) {
  const base = `/${encodeURIComponent(organizationSlug)}/${encodeURIComponent(route)}`;
  if (!detailId) return base;
  const detail = `${base}/${encodeURIComponent(detailId)}`;
  return detailTab && detailTab !== "overview"
    ? `${detail}/${encodeURIComponent(detailTab)}`
    : detail;
}

function handleRouteNavigation(event) {
  event.preventDefault();
  const link = event.currentTarget;
  navigateToRoute(link.dataset.route);
}

function navigateToRoute(route, { replace = false, focus = true } = {}) {
  if (!routeDefinitions[route]) route = "not-found";
  state.route = route;
  state.detailId = null;
  state.detailTab = "overview";
  if (route !== "analytics") {
    state.analyticsMetricCode = null;
  }
  const path = routePath(state.organizationSlug, route);
  if (replace) window.history.replaceState({ route }, "", path);
  else window.history.pushState({ route }, "", path);
  renderRoute();
  closeMobileNavigation();
  if (focus) elements.dashboard.focus?.({ preventScroll: true });
}

async function handleHistoryNavigation() {
  const next = routeFromLocation();
  state.route = next.route;
  state.detailId = next.detailId;
  state.detailTab = next.detailTab;
  state.analyticsTab = next.analyticsTab;
  state.analyticsMetricCode = next.analyticsMetricCode;
  if (next.organizationSlug && next.organizationSlug !== state.organizationSlug) {
    state.organizationSlug = next.organizationSlug;
    await loadWorkspace();
    return;
  }
  renderRoute();
}

function renderRoute({ replaceHistory = false } = {}) {
  const definition = routeDefinitions[state.route];
  const routePanels = document.querySelectorAll(
    "#dashboard > .keys-section, #dashboard > .route-panel",
  );
  for (const panel of routePanels) panel.hidden = true;

  let activePanel = null;
  if (state.route === "customers" && state.detailId) {
    activePanel = elements.customerDetail;
    activePanel.hidden = false;
    renderCustomerDetail();
  } else if (entityDetailDefinitions[state.route] && state.detailId) {
    activePanel = elements.entityDetail;
    activePanel.hidden = false;
    renderEntityDetail();
  } else if (!definition || definition.unavailable) {
    activePanel = elements.unavailableRoute;
    elements.unavailableBreadcrumb.textContent = definition
      ? `${definition.group} / ${definition.title}`
      : "Lago / Not found";
    elements.unavailableTitle.textContent = definition?.title ?? "Page not found";
    elements.unavailableMessage.textContent =
      definition?.unavailable ?? "This organization route does not exist in the Lago workspace.";
    elements.unavailableBoundaryCopy.textContent = definition
      ? "The page stays in the original Lago information architecture without enabling an unscoped or external action."
      : "Use the Lago navigation to return to a retained organization page.";
    activePanel.hidden = false;
  } else if (state.route === "overview") {
    const overviewPanels = document.querySelectorAll('[data-route-panel="overview"]');
    for (const panel of overviewPanels) panel.hidden = false;
    activePanel = document.querySelector("#overview");
  } else {
    activePanel = document.getElementById(state.route);
    if (activePanel) {
      activePanel.hidden = false;
      configureRouteHeading(activePanel, definition);
    }
  }

  for (const link of elements.navigationLinks) {
    const active = link.dataset.route === state.route;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
    link.href = routePath(state.organizationSlug, link.dataset.route);
  }

  const selectedCustomer =
    state.route === "customers" && state.detailId
      ? state.customers.find((customer) => customer.external_id === state.detailId)
      : null;
  const detailDefinition = entityDetailDefinitions[state.route];
  const selectedEntity = detailDefinition
    ? findDetailEntity(detailDefinition, state.detailId)
    : null;
  const title =
    selectedCustomer?.name ??
    (selectedEntity ? detailDefinition.label(selectedEntity) : null) ??
    definition?.title ??
    "Page not found";
  document.title = `${title} · Lago`;
  if (replaceHistory || window.location.hash) {
    window.history.replaceState({ route: state.route }, "", currentRoutePath());
  }
  activePanel?.scrollIntoView({ block: "start" });
}

function currentRoutePath() {
  if (state.route === "analytics") {
    const base = routePath(state.organizationSlug, "analytics");
    if (state.analyticsMetricCode) {
      return `${base}/usage/${encodeURIComponent(state.analyticsMetricCode)}`;
    }
    return state.analyticsTab === "revenue"
      ? base
      : `${base}/${encodeURIComponent(state.analyticsTab)}`;
  }
  return routePath(state.organizationSlug, state.route, state.detailId, state.detailTab);
}

function configureRouteHeading(panel, definition) {
  const headingCopy = panel.querySelector(".section-heading > div");
  const heading = headingCopy?.querySelector("h2");
  if (!headingCopy || !heading) return;
  let breadcrumb = headingCopy.querySelector(".route-breadcrumb");
  if (!breadcrumb) {
    breadcrumb = document.createElement("p");
    breadcrumb.className = "route-breadcrumb";
    headingCopy.prepend(breadcrumb);
  }
  breadcrumb.textContent = `${definition.group} / ${definition.title}`;
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "1");
}

function toggleOrganizationMenu(event) {
  event.stopPropagation();
  const willOpen = elements.organizationMenu.hidden;
  elements.organizationMenu.hidden = !willOpen;
  elements.organizationSwitcher.setAttribute("aria-expanded", String(willOpen));
}

function closeOrganizationMenu() {
  elements.organizationMenu.hidden = true;
  elements.organizationSwitcher.setAttribute("aria-expanded", "false");
}

function closeOrganizationMenuOnOutsideClick(event) {
  if (!event.target.closest(".organization-switcher-shell")) closeOrganizationMenu();
}

function handleGlobalEscape(event) {
  if (event.key !== "Escape") return;
  const openDialog = document.querySelector("dialog[open]");
  if (openDialog) {
    event.preventDefault();
    openDialog.close();
    return;
  }
  closeOrganizationMenu();
  closeMobileNavigation();
}

function renderOrganizationMenu() {
  elements.organizationMenuItems.replaceChildren();
  for (const membership of state.memberships) {
    const organization = membership.organization ?? {};
    const slug = safeText(organization.slug, organization.external_id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "organization-menu-item";
    button.dataset.organizationSlug = slug;
    button.setAttribute("role", "menuitem");
    if (slug === state.organizationSlug) button.setAttribute("aria-current", "true");

    const avatar = document.createElement("span");
    avatar.className = "organization-menu-avatar";
    avatar.textContent = initials(organization.name);
    avatar.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = safeText(organization.name, slug);
    const role = document.createElement("small");
    role.textContent = membership.role === "admin" ? "Administrator" : "Read-only viewer";
    copy.append(name, role);
    button.append(avatar, copy);
    elements.organizationMenuItems.append(button);
  }
}

async function handleOrganizationSelection(event) {
  const button = event.target.closest("button[data-organization-slug]");
  if (!button) return;
  const nextSlug = button.dataset.organizationSlug;
  closeOrganizationMenu();
  if (!nextSlug || nextSlug === state.organizationSlug) return;
  state.organizationSlug = nextSlug;
  state.route = defaultRoute;
  state.detailId = null;
  state.detailTab = "overview";
  window.history.pushState({ route: state.route }, "", routePath(nextSlug, state.route));
  await loadWorkspace();
}

function toggleMobileNavigation() {
  const open = elements.sidebar.classList.toggle("open");
  elements.navBurger.setAttribute("aria-expanded", String(open));
}

function closeMobileNavigation() {
  elements.sidebar.classList.remove("open");
  elements.navBurger.setAttribute("aria-expanded", "false");
}

function renderOperator(operator) {
  state.currentMembershipId = operator.membership_id;
  const isAdmin = state.role === "admin";
  elements.operatorRole.textContent = isAdmin ? "Administrator" : "Read-only viewer";
  elements.operatorBadge.hidden = false;
  elements.rolePill.textContent = isAdmin ? "Admin access" : "Viewer access";
  elements.rolePill.classList.toggle("admin", isAdmin);
  elements.switcherRole.textContent = isAdmin ? "Administrator" : "Read-only viewer";
  elements.openCreateKey.hidden = !isAdmin;
  elements.openCreateSection.hidden = !isAdmin;
  elements.openCreatePricingUnit.hidden = !isAdmin;
  elements.openEditBilling.hidden = !isAdmin;
  elements.openCreateTax.hidden = !isAdmin;
  elements.openCreateAddOn.hidden = !isAdmin;
  elements.openCreateCustomer.hidden = !isAdmin;
  elements.openCreateCoupon.hidden = !isAdmin;
  elements.openApplyCoupon.hidden = !isAdmin;
  elements.openCreatePlan.hidden = !isAdmin;
  elements.openCreateFixedCharge.hidden = !isAdmin;
  elements.openCreateSubscription.hidden = !isAdmin;
  elements.openCreateInvoice.hidden = !isAdmin;
  elements.openCreateWallet.hidden = !isAdmin;
  elements.openCreateCreditNote.hidden = !isAdmin;
  elements.openCreateQuote.hidden = !isAdmin;
  elements.openCreateDataExport.hidden = !isAdmin;
  elements.openCreateDunning.hidden = !isAdmin;
  elements.openCreateMetric.hidden = !isAdmin;
  elements.openCreateFeature.hidden = !isAdmin;
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
  elements.customersEmptyCopy.textContent = isAdmin
    ? "Create the first retained billing customer for this organization."
    : "This organization has no customers. Admin access is required to create one.";
  elements.couponsEmptyCopy.textContent = isAdmin
    ? "Create a coupon for a supported customer discount."
    : "This organization has no coupons. Admin access is required to create one.";
  elements.plansEmptyCopy.textContent = isAdmin
    ? "Create a recurring plan for this organization."
    : "This organization has no active plans. Admin access is required to create one.";
  elements.walletsEmptyCopy.textContent = isAdmin
    ? "Create a manual granted-credit wallet for a retained billing customer."
    : "This organization has no wallets. Admin access is required to create one.";
  elements.creditNotesEmptyCopy.textContent = isAdmin
    ? "Create an itemized internal credit against a finalized invoice."
    : "This organization has no credit notes. Admin access is required to create one.";
  elements.quotesEmptyCopy.textContent = isAdmin
    ? "Create a retained draft proposal for a billing customer."
    : "This organization has no quotes. Admin access is required to create one.";
  elements.dataExportsEmptyCopy.textContent = isAdmin
    ? "Create a bounded CSV snapshot for a retained billing resource."
    : "This organization has no exports. Admin access is required to create one.";
  elements.subscriptionsEmptyCopy.textContent = isAdmin
    ? "Create a customer subscription from an active plan."
    : "This organization has no subscriptions. Admin access is required to create one.";
  elements.invoicesEmptyCopy.textContent = isAdmin
    ? "Create a finalized one-off invoice or wait for subscription billing."
    : "This organization has no invoices. Admin access is required to create one.";
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
  elements.switcherMonogram.textContent = initials(name);
  elements.switcherName.textContent = name;
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
  elements.billingIssuingAdjustment.value =
    entity.subscription_invoice_issuing_date_adjustment ?? "align_with_finalization_date";
  elements.billingIssuingAnchor.value =
    entity.subscription_invoice_issuing_date_anchor ?? "next_period_start";
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
        subscription_invoice_issuing_date_adjustment: elements.billingIssuingAdjustment.value,
        subscription_invoice_issuing_date_anchor: elements.billingIssuingAnchor.value,
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

async function renderBillingAdvanced() {
  elements.billingDefaultTaxes.replaceChildren();
  for (const tax of state.taxes) {
    const option = document.createElement("option");
    option.value = tax.code;
    option.textContent = `${safeText(tax.name, tax.code)} · ${Number(tax.rate) || 0}%`;
    elements.billingDefaultTaxes.append(option);
  }
  elements.billingDefaultDunning.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "No billing-entity override";
  elements.billingDefaultDunning.append(empty);
  for (const campaign of state.dunningCampaigns) {
    const option = document.createElement("option");
    option.value = campaign.code;
    option.textContent = safeText(campaign.name, campaign.code);
    elements.billingDefaultDunning.append(option);
  }
  const controls = elements.billingAdvancedForm.querySelectorAll("input, select, button");
  for (const control of controls) control.disabled = state.role !== "admin";
  try {
    const [taxPayload, dunningPayload] = await Promise.all([
      requestJson(endpoints.billingEntityTaxes),
      requestJson(endpoints.billingEntityDunning),
    ]);
    const selectedTaxes = new Set((taxPayload.taxes ?? []).map((tax) => tax.code));
    for (const option of elements.billingDefaultTaxes.options) {
      option.selected = selectedTaxes.has(option.value);
    }
    elements.billingDefaultDunning.value = dunningPayload.dunning_campaign?.code ?? "";
  } catch (error) {
    elements.billingAdvancedError.textContent = errorMessage(error);
    elements.billingAdvancedError.hidden = false;
  }
}

async function submitBillingAdvanced(event) {
  event.preventDefault();
  if (state.role !== "admin") return;
  setBusy(elements.saveBillingAdvanced, true, "Saving…");
  elements.billingAdvancedError.hidden = true;
  try {
    const taxCodes = Array.from(elements.billingDefaultTaxes.selectedOptions).map(
      (option) => option.value,
    );
    const dunningCode = elements.billingDefaultDunning.value;
    const requests = [
      requestJson(endpoints.billingEntityTaxes, {
        method: "PUT",
        body: { billing_entity: { tax_codes: taxCodes } },
      }),
      dunningCode
        ? requestJson(endpoints.billingEntityDunning, {
            method: "PUT",
            body: { billing_entity: { dunning_campaign_code: dunningCode } },
          })
        : requestJson(endpoints.billingEntityDunning, { method: "DELETE" }),
    ];
    const file = elements.billingLogoFile.files?.[0];
    if (file) {
      if (file.size > 1_048_576) throw new Error("Billing entity logo must be no larger than 1 MB");
      requests.push(
        requestJson(endpoints.billingEntityLogo, {
          method: "PUT",
          body: {
            logo: {
              filename: file.name,
              mime_type: file.type,
              data_base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
            },
          },
        }),
      );
    }
    await Promise.all(requests);
    elements.billingLogoFile.value = "";
    await renderBillingAdvanced();
    hidePageError();
  } catch (error) {
    elements.billingAdvancedError.textContent = errorMessage(error);
    elements.billingAdvancedError.hidden = false;
  } finally {
    setBusy(elements.saveBillingAdvanced, false, "Save defaults");
  }
}

async function removeBillingLogo() {
  if (state.role !== "admin") return;
  setBusy(elements.removeBillingLogo, true, "Removing…");
  try {
    await requestJson(endpoints.billingEntityLogo, { method: "DELETE" });
    elements.billingLogoFile.value = "";
    hidePageError();
  } catch (error) {
    elements.billingAdvancedError.textContent = errorMessage(error);
    elements.billingAdvancedError.hidden = false;
  } finally {
    setBusy(elements.removeBillingLogo, false, "Remove logo");
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
  decorateEntityRows(elements.keysTableBody, state.keys, "api-keys");
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
  decorateEntityRows(elements.sectionsTableBody, state.sections, "invoice-sections");
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

function renderPricingUnits(pricingUnits) {
  state.pricingUnits = Array.isArray(pricingUnits) ? pricingUnits : [];
  elements.pricingUnitsTableBody.replaceChildren();
  elements.pricingUnitsLoading.hidden = true;
  elements.pricingUnitsEmpty.hidden = state.pricingUnits.length !== 0;
  elements.pricingUnitsTableShell.hidden = state.pricingUnits.length === 0;
  for (const pricingUnit of state.pricingUnits) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const label = document.createElement("span");
    label.className = "key-name";
    label.textContent = safeText(pricingUnit.name, "Unnamed pricing unit");
    name.append(label);
    const code = document.createElement("td");
    code.textContent = safeText(pricingUnit.code, "—");
    const shortName = document.createElement("td");
    shortName.textContent = safeText(pricingUnit.short_name, "—");
    const description = document.createElement("td");
    description.textContent = safeText(pricingUnit.description, "No description");
    if (!pricingUnit.description) description.className = "muted";
    const actions = document.createElement("td");
    actions.className = "actions-column";
    if (state.role === "admin") {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "row-action";
      edit.dataset.pricingUnitId = pricingUnit.lago_id;
      edit.textContent = "Edit";
      actions.append(edit);
    } else {
      actions.textContent = "Read only";
      actions.classList.add("muted");
    }
    row.append(name, code, shortName, description, actions);
    elements.pricingUnitsTableBody.append(row);
  }
  decorateEntityRows(elements.pricingUnitsTableBody, state.pricingUnits, "pricing-units");
}

function renderReceipts(receipts) {
  state.receipts = Array.isArray(receipts) ? receipts : [];
  elements.receiptsTableBody.replaceChildren();
  elements.receiptsLoading.hidden = true;
  elements.receiptsEmpty.hidden = state.receipts.length !== 0;
  elements.receiptsTableShell.hidden = state.receipts.length === 0;
  for (const receipt of state.receipts)
    elements.receiptsTableBody.append(createReceiptRow(receipt));
  decorateEntityRows(elements.receiptsTableBody, state.receipts, "payment-receipts");
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
  decorateEntityRows(elements.taxesTableBody, state.taxes, "taxes");
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
  decorateEntityRows(elements.addOnsTableBody, state.addOns, "add-ons");
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

function renderCustomers(customers) {
  state.customers = Array.isArray(customers) ? customers : [];
  elements.customersTableBody.replaceChildren();
  elements.customersLoading.hidden = true;
  elements.customersEmpty.hidden = state.customers.length !== 0;
  elements.customersTableShell.hidden = state.customers.length === 0;
  for (const customer of state.customers) {
    elements.customersTableBody.append(createCustomerRow(customer));
  }
}

function createCustomerRow(customer) {
  const row = document.createElement("tr");
  const customerCell = document.createElement("td");
  const name = document.createElement("a");
  name.className = "key-name entity-link";
  name.href = routePath(state.organizationSlug, "customers", customer.external_id);
  name.dataset.customerRoute = customer.external_id;
  name.textContent = safeText(customer.name, "Unnamed customer");
  const externalId = document.createElement("span");
  externalId.className = "key-id";
  externalId.textContent = safeText(customer.external_id, "—");
  customerCell.append(name, externalId);
  const emailCell = document.createElement("td");
  emailCell.textContent = safeText(customer.email, "—");
  const currencyCell = document.createElement("td");
  currencyCell.textContent = safeText(customer.currency, "—");
  const timezoneCell = document.createElement("td");
  timezoneCell.textContent = safeText(customer.timezone, "—");
  const termCell = document.createElement("td");
  termCell.textContent =
    customer.net_payment_term === null
      ? "Default"
      : `${nonNegativeNumber(customer.net_payment_term)} days`;
  const actionCell = document.createElement("td");
  actionCell.className = "actions-column";
  if (state.role === "admin") {
    actionCell.append(customerActionButton("Edit", customer.external_id));
  } else {
    actionCell.textContent = "Read only";
    actionCell.classList.add("muted");
  }
  row.append(customerCell, emailCell, currencyCell, timezoneCell, termCell, actionCell);
  return row;
}

function customerActionButton(label, externalId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-action";
  button.dataset.customerExternalId = externalId;
  button.textContent = label;
  return button;
}

function handleCustomerAction(event) {
  const routeLink = event.target.closest("a[data-customer-route]");
  if (routeLink) {
    event.preventDefault();
    navigateToCustomer(routeLink.dataset.customerRoute);
    return;
  }
  const button = event.target.closest("button[data-customer-external-id]");
  if (!button || state.role !== "admin") return;
  const customer = state.customers.find(
    (candidate) => candidate.external_id === button.dataset.customerExternalId,
  );
  if (customer) openEditCustomerDialog(customer);
}

function navigateToCustomer(externalId, tab = "overview", { replace = false } = {}) {
  state.route = "customers";
  state.detailId = externalId;
  state.detailTab = tab;
  const path = routePath(state.organizationSlug, state.route, externalId, tab);
  if (replace) window.history.replaceState({ route: state.route, externalId, tab }, "", path);
  else window.history.pushState({ route: state.route, externalId, tab }, "", path);
  renderRoute();
  closeMobileNavigation();
}

function openSelectedCustomerEditor() {
  if (state.role !== "admin") return;
  const customer = state.customers.find((candidate) => candidate.external_id === state.detailId);
  if (customer) openEditCustomerDialog(customer);
}

function handleCustomerTab(event) {
  if (!state.detailId) return;
  navigateToCustomer(state.detailId, event.currentTarget.dataset.customerTab);
}

function renderCustomerDetail() {
  const customer = state.customers.find((candidate) => candidate.external_id === state.detailId);
  elements.customerDetailTabPanel.replaceChildren();
  if (!customer) {
    const missing = document.createElement("div");
    missing.className = "detail-empty";
    const title = document.createElement("h2");
    title.textContent = "Customer not found";
    const copy = document.createElement("p");
    copy.textContent =
      "This customer is not available in the selected organization. No other tenant was queried.";
    missing.append(title, copy);
    elements.customerDetailTabPanel.append(missing);
    elements.customerDetailEdit.hidden = true;
    elements.customerPortalLink.hidden = true;
    elements.customerDetailEditAside.hidden = true;
    return;
  }

  const name = safeText(customer.name, "Unnamed customer");
  elements.customerDetailAvatar.textContent = initials(name);
  elements.customerDetailName.textContent = name;
  elements.customerDetailExternalId.textContent = safeText(customer.external_id, "—");
  elements.customerDetailFieldName.textContent = name;
  elements.customerDetailFieldId.textContent = safeText(customer.external_id, "—");
  elements.customerDetailFieldCurrency.textContent = safeText(customer.currency, "—");
  elements.customerDetailFieldEmail.textContent = safeText(customer.email, "—");
  elements.customerDetailFieldTimezone.textContent = safeText(customer.timezone, "—");
  elements.customerDetailFieldTerm.textContent =
    customer.net_payment_term === null
      ? "Organization default"
      : `${nonNegativeNumber(customer.net_payment_term)} days`;
  elements.customerDetailEdit.hidden = state.role !== "admin";
  elements.customerPortalLink.hidden = state.role !== "admin";
  elements.customerDetailEditAside.hidden = state.role !== "admin";

  for (const tab of elements.customerDetailTabs) {
    const selected = tab.dataset.customerTab === state.detailTab;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }

  if (state.detailTab === "analytics") {
    void renderCustomerAnalytics(customer);
    return;
  }
  if (state.detailTab === "wallets") {
    renderCustomerCollectionTab(
      "Wallets",
      state.wallets.filter((wallet) => wallet.external_customer_id === customer.external_id),
      "No wallets are attached to this customer.",
    );
    return;
  }
  if (state.detailTab === "invoices") {
    renderCustomerCollectionTab(
      "Invoices",
      state.invoices.filter((invoice) => invoice.external_customer_id === customer.external_id),
      "No invoices are available for this customer.",
    );
    return;
  }
  if (state.detailTab === "credit-notes") {
    renderCustomerCollectionTab(
      "Credit notes",
      state.creditNotes.filter(
        (creditNote) => creditNote.external_customer_id === customer.external_id,
      ),
      "No credit notes are available for this customer.",
    );
    return;
  }
  if (state.detailTab === "settings") {
    void renderCustomerSettingsTab(customer);
    return;
  }
  renderCustomerOverview(customer);
}

async function renderCustomerAnalytics(customer) {
  elements.customerDetailTabPanel.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "table-loading compact";
  loading.textContent = "Loading customer analytics…";
  elements.customerDetailTabPanel.append(loading);
  try {
    const query = new URLSearchParams({ customer_external_id: customer.external_id });
    const payload = await requestJson(`${endpoints.analytics}?${query}`);
    if (state.detailTab !== "analytics" || state.detailId !== customer.external_id) return;
    const analytics = payload.analytics;
    elements.customerDetailTabPanel.replaceChildren(
      createDetailSummary(
        "Revenue",
        formatMoney(analytics.revenue_streams.total_amount_minor, analytics.currency),
        "Finalized invoices in the selected year",
      ),
      createDetailSummary(
        "Usage",
        formatMoney(analytics.usage.total_amount_minor, analytics.currency),
        `${analytics.usage.total_events_count} metered events`,
      ),
      createDetailSummary(
        "Prepaid credits",
        formatMoney(analytics.prepaid_credits.balance_minor, analytics.currency),
        `${analytics.prepaid_credits.wallets_count} active wallets`,
      ),
    );
  } catch (error) {
    elements.customerDetailTabPanel.replaceChildren();
    const failed = document.createElement("p");
    failed.className = "form-error inline-error";
    failed.textContent = errorMessage(error);
    elements.customerDetailTabPanel.append(failed);
  }
}

function selectAnalyticsTab(event) {
  state.analyticsTab = event.currentTarget.dataset.analyticsTab;
  state.analyticsMetricCode = null;
  window.history.pushState(
    { route: "analytics", analyticsTab: state.analyticsTab },
    "",
    `${routePath(state.organizationSlug, "analytics")}/${encodeURIComponent(state.analyticsTab)}`,
  );
  renderAnalytics(state.analytics);
}

function renderAnalytics(analytics) {
  state.analytics = analytics;
  elements.analyticsLoading.hidden = Boolean(analytics);
  elements.analyticsContent.hidden = !analytics;
  if (!analytics) return;
  if (!elements.analyticsFrom.value) elements.analyticsFrom.value = analytics.from;
  if (!elements.analyticsTo.value) elements.analyticsTo.value = analytics.to;
  for (const tab of elements.analyticsTabs) {
    const selected = tab.dataset.analyticsTab === state.analyticsTab;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
  elements.analyticsCurrency.textContent = analytics.currency;
  elements.analyticsSummary.replaceChildren();
  elements.analyticsChart.replaceChildren();
  elements.analyticsBreakdown.replaceChildren();
  const tab = state.analyticsTab;
  if (tab === "mrr") {
    elements.analyticsChartEyebrow.textContent = "Monthly recurring revenue";
    elements.analyticsChartTitle.textContent = "Current MRR";
    appendMetricCards([
      [
        "MRR",
        formatMoney(analytics.mrr.amount_minor, analytics.currency),
        "Normalized recurring plan value",
      ],
      [
        "Subscriptions",
        String(analytics.mrr.subscriptions_count),
        "Active and past-due subscriptions",
      ],
    ]);
    renderBarChart(
      [{ period: "Current", amount_minor: analytics.mrr.amount_minor }],
      analytics.currency,
    );
    renderBreakdown(
      analytics.mrr.plan_breakdown?.length
        ? analytics.mrr.plan_breakdown.map((plan) => [
            `${safeText(plan.name, plan.code)} (${plan.code})`,
            `${formatMoney(plan.amount_minor, analytics.currency)} · ${plan.subscriptions_count} subscriptions`,
          ])
        : [["Active recurring subscriptions", analytics.mrr.subscriptions_count]],
    );
    return;
  }
  if (tab === "usage") {
    elements.analyticsChartEyebrow.textContent = "Usage";
    elements.analyticsChartTitle.textContent = state.analyticsMetricCode
      ? `${state.analyticsMetricCode} usage over time`
      : "Metered usage over time";
    appendMetricCards([
      [
        "Usage revenue",
        formatMoney(analytics.usage.total_amount_minor, analytics.currency),
        "Daily rated usage",
      ],
      ["Units", analytics.usage.total_units, "Aggregated billable units"],
      ["Events", String(analytics.usage.total_events_count), "Metered event count"],
    ]);
    renderBarChart(analytics.usage.daily, analytics.currency);
    renderBreakdown(
      analytics.usage.billable_metrics.map((metric) => [
        metric.code,
        `${formatMoney(metric.amount_minor, analytics.currency)} · ${metric.units} units`,
        metric.code,
      ]),
    );
    return;
  }
  if (tab === "credits") {
    elements.analyticsChartEyebrow.textContent = "Prepaid credits";
    elements.analyticsChartTitle.textContent = "Credit movement over time";
    appendMetricCards([
      [
        "Available balance",
        formatMoney(analytics.prepaid_credits.balance_minor, analytics.currency),
        "Across active wallets",
      ],
      [
        "Consumed",
        formatMoney(analytics.prepaid_credits.consumed_minor, analytics.currency),
        "Lifetime wallet consumption",
      ],
      ["Wallets", String(analytics.prepaid_credits.wallets_count), "Active wallets"],
    ]);
    renderBarChart(
      analytics.prepaid_credits.monthly.map((point) => ({
        period: point.period,
        amount_minor: point.granted_minor + point.purchased_minor,
      })),
      analytics.currency,
    );
    renderBreakdown(
      analytics.prepaid_credits.monthly.map((point) => [
        point.period,
        `${formatMoney(point.granted_minor + point.purchased_minor, analytics.currency)} funded · ${formatMoney(point.consumed_minor, analytics.currency)} consumed`,
      ]),
    );
    return;
  }
  if (tab === "invoices") {
    elements.analyticsChartEyebrow.textContent = "Invoices";
    elements.analyticsChartTitle.textContent = "Invoice value by status";
    appendMetricCards([
      [
        "Invoice value",
        formatMoney(analytics.invoices.total_amount_minor, analytics.currency),
        "All invoices in range",
      ],
      ["Invoices", String(analytics.invoices.total_count), "Documents in range"],
    ]);
    renderBarChart(
      analytics.invoices.breakdown.map((item) => ({
        period: `${item.status} · ${item.payment_status}`,
        amount_minor: item.amount_minor,
      })),
      analytics.currency,
    );
    renderBreakdown([
      ...(analytics.invoices.collection_breakdown ?? []).map((item) => [
        humanize(item.status),
        `${formatMoney(item.amount_minor, analytics.currency)} · ${item.invoice_count} invoices`,
      ]),
      ...analytics.invoices.breakdown.map((item) => [
        `${humanize(item.status)} · ${humanize(item.payment_status)}`,
        `${formatMoney(item.amount_minor, analytics.currency)} · ${item.invoice_count} invoices`,
      ]),
    ]);
    return;
  }
  elements.analyticsChartEyebrow.textContent = "Revenue";
  elements.analyticsChartTitle.textContent = "Revenue streams over time";
  appendMetricCards([
    [
      "Revenue",
      formatMoney(analytics.revenue_streams.total_amount_minor, analytics.currency),
      "Finalized invoice value",
    ],
    [
      "Streams",
      String(analytics.revenue_streams.breakdown.length),
      "Subscription and one-off revenue",
    ],
  ]);
  renderBarChart(analytics.revenue_streams.monthly, analytics.currency);
  renderBreakdown([
    ...analytics.revenue_streams.breakdown.map((item) => [
      humanize(item.stream),
      `${formatMoney(item.amount_minor, analytics.currency)} · ${item.invoice_count} invoices`,
    ]),
    ...(analytics.revenue_streams.plan_breakdown ?? []).map((item) => [
      `Plan · ${safeText(item.name, item.code)}`,
      `${formatMoney(item.amount_minor, analytics.currency)} · ${item.invoice_count} invoices`,
    ]),
    ...(analytics.revenue_streams.customer_breakdown ?? []).map((item) => [
      `Customer · ${safeText(item.name, item.code)}`,
      `${formatMoney(item.amount_minor, analytics.currency)} · ${item.invoice_count} invoices`,
    ]),
  ]);
}

function appendMetricCards(cards) {
  for (const [label, value, copy] of cards) {
    const card = document.createElement("article");
    card.className = "metric-card";
    const title = document.createElement("p");
    title.textContent = label;
    const amount = document.createElement("strong");
    amount.textContent = value;
    const detail = document.createElement("small");
    detail.textContent = copy;
    card.append(title, amount, detail);
    elements.analyticsSummary.append(card);
  }
}

function renderBarChart(points, currency) {
  const normalized = Array.isArray(points) ? points : [];
  if (normalized.length === 0) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "No data is available for this range.";
    elements.analyticsChart.append(empty);
    return;
  }
  const maximum = Math.max(1, ...normalized.map((point) => Number(point.amount_minor) || 0));
  for (const point of normalized.slice(-24)) {
    const item = document.createElement("div");
    item.className = "bar-chart-item";
    const value = document.createElement("span");
    value.className = "bar-chart-value";
    value.textContent = formatMoney(point.amount_minor, currency);
    const bar = document.createElement("i");
    bar.style.setProperty(
      "--bar-height",
      `${Math.max(3, ((Number(point.amount_minor) || 0) / maximum) * 100)}%`,
    );
    const label = document.createElement("small");
    label.textContent = point.period;
    item.append(value, bar, label);
    elements.analyticsChart.append(item);
  }
}

function renderBreakdown(rows) {
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "No breakdown is available for this range.";
    elements.analyticsBreakdown.append(empty);
    return;
  }
  for (const [label, value, metricCode] of rows) {
    const row = document.createElement("div");
    const term = metricCode ? document.createElement("button") : document.createElement("strong");
    term.textContent = label;
    if (metricCode) {
      term.type = "button";
      term.className = "analytics-drilldown";
      term.addEventListener("click", () => navigateToUsageMetric(metricCode));
    }
    const description = document.createElement("span");
    description.textContent = String(value);
    row.append(term, description);
    elements.analyticsBreakdown.append(row);
  }
}

async function navigateToUsageMetric(metricCode) {
  state.analyticsTab = "usage";
  state.analyticsMetricCode = metricCode;
  window.history.pushState(
    { route: "analytics", analyticsTab: "usage", analyticsMetricCode: metricCode },
    "",
    `${routePath(state.organizationSlug, "analytics")}/usage/${encodeURIComponent(metricCode)}`,
  );
  await refreshAnalytics();
}

async function refreshAnalytics() {
  setBusy(elements.refreshAnalytics, true, "Loading…");
  try {
    const query = new URLSearchParams({
      from: elements.analyticsFrom.value,
      to: elements.analyticsTo.value,
    });
    if (state.analyticsMetricCode) query.set("billable_metric_code", state.analyticsMetricCode);
    const payload = await requestJson(`${endpoints.analytics}?${query}`);
    renderAnalytics(payload.analytics);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  } finally {
    setBusy(elements.refreshAnalytics, false, "Apply");
  }
}

function renderForecasts(forecast) {
  state.forecast = forecast;
  elements.forecastsLoading.hidden = Boolean(forecast);
  elements.forecastsContent.hidden = !forecast;
  if (!forecast) return;
  elements.forecastChart.replaceChildren();
  elements.forecastTableBody.replaceChildren();
  const maximum = Math.max(
    1,
    ...forecast.projected_months.flatMap((point) => [
      point.optimistic_amount_minor,
      point.realistic_amount_minor,
      point.conservative_amount_minor,
    ]),
  );
  for (const point of forecast.projected_months) {
    const group = document.createElement("div");
    group.className = "forecast-bar-group";
    for (const [scenario, value] of [
      ["optimistic", point.optimistic_amount_minor],
      ["realistic", point.realistic_amount_minor],
      ["conservative", point.conservative_amount_minor],
    ]) {
      const bar = document.createElement("i");
      bar.className = `forecast-bar ${scenario}`;
      bar.style.setProperty("--bar-height", `${Math.max(3, (value / maximum) * 100)}%`);
      bar.title = `${humanize(scenario)}: ${formatMoney(value, forecast.currency)}`;
      group.append(bar);
    }
    const label = document.createElement("small");
    label.textContent = point.period;
    group.append(label);
    elements.forecastChart.append(group);

    const row = document.createElement("tr");
    for (const value of [
      point.period,
      formatMoney(point.optimistic_amount_minor, forecast.currency),
      formatMoney(point.realistic_amount_minor, forecast.currency),
      formatMoney(point.conservative_amount_minor, forecast.currency),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    elements.forecastTableBody.append(row);
  }
  elements.forecastMethod.textContent = `Method: ${forecast.methodology}. Generated ${formatDate(forecast.generated_at)}.`;
}

async function refreshForecasts() {
  elements.forecastsLoading.hidden = false;
  elements.forecastsContent.hidden = true;
  try {
    const payload = await requestJson(
      `${endpoints.forecasts}?months=${elements.forecastMonths.value}`,
    );
    renderForecasts(payload.forecast);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

function renderBillableMetrics(metrics = state.billableMetrics) {
  if (metrics !== state.billableMetrics)
    state.billableMetrics = Array.isArray(metrics) ? metrics : [];
  const search = elements.metricSearch.value.trim().toLowerCase();
  const visible = state.billableMetrics.filter((metric) =>
    `${metric.name ?? ""} ${metric.code ?? ""}`.toLowerCase().includes(search),
  );
  elements.metricsTableBody.replaceChildren();
  elements.metricsLoading.hidden = true;
  elements.metricsEmpty.hidden = visible.length !== 0;
  elements.metricsTableShell.hidden = visible.length === 0;
  for (const metric of visible) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "key-name";
    name.textContent = safeText(metric.name, "Unnamed metric");
    const code = document.createElement("span");
    code.className = "key-id";
    code.textContent = metric.code;
    nameCell.append(name, code);
    const actionCell = catalogActions("metric", metric.code);
    for (const value of [
      humanize(metric.aggregation_type),
      safeText(metric.field_name, "—"),
      metric.recurring ? "Yes" : "No",
      formatDate(metric.created_at),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    row.prepend(nameCell);
    row.append(actionCell);
    elements.metricsTableBody.append(row);
  }
  decorateEntityRows(elements.metricsTableBody, visible, "billable-metrics");
}

function renderFeatures(features = state.features) {
  if (features !== state.features) state.features = Array.isArray(features) ? features : [];
  const search = elements.featureSearch.value.trim().toLowerCase();
  const visible = state.features.filter((feature) =>
    `${feature.name ?? ""} ${feature.code ?? ""}`.toLowerCase().includes(search),
  );
  elements.featuresTableBody.replaceChildren();
  elements.featuresLoading.hidden = true;
  elements.featuresEmpty.hidden = visible.length !== 0;
  elements.featuresTableShell.hidden = visible.length === 0;
  for (const feature of visible) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "key-name";
    name.textContent = safeText(feature.name, "Unnamed feature");
    const code = document.createElement("span");
    code.className = "key-id";
    code.textContent = feature.code;
    nameCell.append(name, code);
    row.append(nameCell);
    for (const value of [
      feature.subscriptions_count,
      feature.plans_count,
      formatDate(feature.created_at),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = String(value ?? 0);
      row.append(cell);
    }
    row.append(catalogActions("feature", feature.lago_id));
    elements.featuresTableBody.append(row);
  }
  decorateEntityRows(elements.featuresTableBody, visible, "features");
}

function catalogActions(kind, identifier) {
  const cell = document.createElement("td");
  cell.className = "actions-column";
  if (state.role !== "admin") {
    cell.textContent = "Read only";
    cell.classList.add("muted");
    return cell;
  }
  const actions = [
    ["Edit", "edit", false],
    ...(kind === "metric" ? [["Duplicate", "duplicate", false]] : []),
    ["Delete", "delete", true],
  ];
  for (const [label, action, danger] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = danger ? "row-action danger" : "row-action";
    button.dataset.catalogKind = kind;
    button.dataset.catalogAction = action;
    button.dataset.catalogId = identifier;
    button.textContent = label;
    cell.append(button);
  }
  return cell;
}

async function handleMetricAction(event) {
  const button = event.target.closest("button[data-catalog-kind='metric']");
  if (!button || state.role !== "admin") return;
  const metric = state.billableMetrics.find((item) => item.code === button.dataset.catalogId);
  if (!metric) return;
  if (button.dataset.catalogAction === "edit") openEditMetricDialog(metric);
  else if (button.dataset.catalogAction === "duplicate") openDuplicateMetricDialog(metric);
  else openCatalogDeletion("metric", metric.code, safeText(metric.name, metric.code));
}

async function handleFeatureAction(event) {
  const button = event.target.closest("button[data-catalog-kind='feature']");
  if (!button || state.role !== "admin") return;
  const feature = state.features.find((item) => item.lago_id === button.dataset.catalogId);
  if (!feature) return;
  if (button.dataset.catalogAction === "delete") {
    openCatalogDeletion("feature", feature.lago_id, safeText(feature.name, feature.code));
    return;
  }
  try {
    const payload = await requestJson(featureEndpoint(feature.lago_id));
    Object.assign(feature, payload.feature);
    openEditFeatureDialog(feature);
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

function openCreateMetricDialog() {
  state.metricFormMode = "create";
  state.selectedMetricCode = null;
  elements.metricForm.reset();
  elements.metricCode.disabled = false;
  elements.metricAggregation.disabled = false;
  elements.metricFormTitle.textContent = "Create billable metric";
  elements.submitMetricForm.textContent = "Create metric";
  elements.metricFormError.hidden = true;
  elements.metricFormDialog.showModal();
  elements.metricName.focus();
}

function openEditMetricDialog(metric) {
  state.metricFormMode = "edit";
  state.selectedMetricCode = metric.code;
  elements.metricName.value = safeText(metric.name, "");
  elements.metricCode.value = metric.code;
  elements.metricCode.disabled = true;
  elements.metricAggregation.value = metric.aggregation_type;
  elements.metricAggregation.disabled = true;
  elements.metricField.value = safeText(metric.field_name, "");
  elements.metricDescription.value = safeText(metric.description, "");
  elements.metricExpression.value = safeText(metric.expression, "");
  elements.metricRecurring.checked = Boolean(metric.recurring);
  elements.metricFormTitle.textContent = "Edit billable metric";
  elements.submitMetricForm.textContent = "Save metric";
  elements.metricFormError.hidden = true;
  elements.metricFormDialog.showModal();
}

function openDuplicateMetricDialog(metric) {
  state.metricFormMode = "create";
  state.selectedMetricCode = null;
  elements.metricName.value = `${safeText(metric.name, metric.code)} copy`;
  elements.metricCode.value = `${metric.code}_copy`;
  elements.metricCode.disabled = false;
  elements.metricAggregation.value = metric.aggregation_type;
  elements.metricAggregation.disabled = false;
  elements.metricField.value = safeText(metric.field_name, "");
  elements.metricDescription.value = safeText(metric.description, "");
  elements.metricExpression.value = safeText(metric.expression, "");
  elements.metricRecurring.checked = Boolean(metric.recurring);
  elements.metricFormTitle.textContent = "Duplicate billable metric";
  elements.submitMetricForm.textContent = "Create metric";
  elements.metricFormError.hidden = true;
  elements.metricFormDialog.showModal();
  elements.metricCode.focus();
  elements.metricCode.select();
}

async function submitMetricForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.metricFormDialog.close();
  if (!elements.metricForm.reportValidity()) return;
  const create = state.metricFormMode === "create";
  setBusy(elements.submitMetricForm, true, create ? "Creating…" : "Saving…");
  try {
    await requestJson(
      create ? endpoints.billableMetrics : metricEndpoint(state.selectedMetricCode),
      {
        method: create ? "POST" : "PUT",
        body: {
          billable_metric: {
            name: elements.metricName.value.trim(),
            code: elements.metricCode.value.trim(),
            description: optionalFormValue(elements.metricDescription.value),
            aggregation_type: elements.metricAggregation.value,
            field_name: optionalFormValue(elements.metricField.value),
            expression: optionalFormValue(elements.metricExpression.value),
            recurring: elements.metricRecurring.checked,
          },
        },
      },
    );
    elements.metricFormDialog.close();
    await refreshBillableMetrics();
  } catch (error) {
    elements.metricFormError.textContent = errorMessage(error);
    elements.metricFormError.hidden = false;
  } finally {
    setBusy(elements.submitMetricForm, false, create ? "Create metric" : "Save metric");
  }
}

function openCreateFeatureDialog() {
  state.featureFormMode = "create";
  state.selectedFeatureId = null;
  elements.featureForm.reset();
  elements.featureCode.disabled = false;
  elements.featurePrivileges.replaceChildren();
  elements.featureFormTitle.textContent = "Create feature";
  elements.submitFeatureForm.textContent = "Create feature";
  elements.featureFormError.hidden = true;
  elements.featureFormDialog.showModal();
  elements.featureName.focus();
}

function openEditFeatureDialog(feature) {
  state.featureFormMode = "edit";
  state.selectedFeatureId = feature.lago_id;
  elements.featureName.value = safeText(feature.name, "");
  elements.featureCode.value = feature.code;
  elements.featureCode.disabled = true;
  elements.featureDescription.value = safeText(feature.description, "");
  elements.featurePrivileges.replaceChildren();
  for (const privilege of feature.privileges ?? []) addPrivilegeEditor(privilege);
  elements.featureFormTitle.textContent = "Edit feature";
  elements.submitFeatureForm.textContent = "Save feature";
  elements.featureFormError.hidden = true;
  elements.featureFormDialog.showModal();
}

function addPrivilegeEditor(privilege = {}) {
  const editor = document.createElement("fieldset");
  editor.className = "privilege-row";
  if (privilege.lago_id) editor.dataset.privilegeId = privilege.lago_id;
  const legend = document.createElement("legend");
  legend.textContent = privilege.name || "New privilege";
  const name = labeledInput("Name", "text", privilege.name);
  name.input.dataset.privilegeField = "name";
  const code = labeledInput("Code", "text", privilege.code);
  code.input.dataset.privilegeField = "code";
  if (privilege.lago_id) code.input.disabled = true;
  const typeLabel = document.createElement("label");
  typeLabel.textContent = "Value type";
  const type = document.createElement("select");
  type.dataset.privilegeField = "value_type";
  for (const value of ["boolean", "integer", "string", "select"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = humanize(value);
    type.append(option);
  }
  type.value = privilege.value_type || "boolean";
  if (privilege.lago_id) type.disabled = true;
  typeLabel.append(type);
  const options = labeledInput(
    "Select options (comma separated)",
    "text",
    privilege.config?.select_options?.join(", ") ?? "",
  );
  options.label.className = "privilege-options";
  options.input.dataset.privilegeField = "options";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "text-button danger";
  remove.dataset.removePrivilege = "1";
  remove.textContent = "Remove";
  editor.append(legend, name.label, code.label, typeLabel, options.label, remove);
  elements.featurePrivileges.append(editor);
}

function labeledInput(labelText, type, value = "") {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.value = safeText(value, "");
  label.append(input);
  return { label, input };
}

function removePrivilegeEditor(event) {
  const button = event.target.closest("button[data-remove-privilege]");
  button?.closest(".privilege-row")?.remove();
}

async function submitFeatureForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.featureFormDialog.close();
  if (!elements.featureForm.reportValidity()) return;
  const privileges = Array.from(elements.featurePrivileges.querySelectorAll(".privilege-row")).map(
    (row) => {
      const valueType = row.querySelector("[data-privilege-field='value_type']").value;
      const options = row
        .querySelector("[data-privilege-field='options']")
        .value.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      return {
        ...(row.dataset.privilegeId ? { id: row.dataset.privilegeId } : {}),
        name: optionalFormValue(row.querySelector("[data-privilege-field='name']").value),
        code: row.querySelector("[data-privilege-field='code']").value.trim(),
        value_type: valueType,
        ...(valueType === "select" ? { config: { select_options: options } } : {}),
      };
    },
  );
  const create = state.featureFormMode === "create";
  setBusy(elements.submitFeatureForm, true, create ? "Creating…" : "Saving…");
  try {
    await requestJson(create ? endpoints.features : featureEndpoint(state.selectedFeatureId), {
      method: create ? "POST" : "PUT",
      body: {
        feature: {
          name: optionalFormValue(elements.featureName.value),
          code: elements.featureCode.value.trim(),
          description: optionalFormValue(elements.featureDescription.value),
          privileges,
        },
      },
    });
    elements.featureFormDialog.close();
    await refreshFeatures();
  } catch (error) {
    elements.featureFormError.textContent = errorMessage(error);
    elements.featureFormError.hidden = false;
  } finally {
    setBusy(elements.submitFeatureForm, false, create ? "Create feature" : "Save feature");
  }
}

function openCatalogDeletion(kind, identifier, name) {
  state.confirmMode = `delete-${kind}`;
  if (kind === "metric") state.selectedMetricCode = identifier;
  else state.selectedFeatureId = identifier;
  elements.confirmError.hidden = true;
  elements.confirmTitle.textContent = `Delete ${kind}?`;
  elements.confirmCopy.textContent = `Delete “${name}”? This is blocked while the catalog item is in use.`;
  elements.confirmAction.textContent = `Delete ${kind}`;
  elements.confirmDialog.showModal();
}

function renderAiHistory(conversations) {
  state.aiConversations = Array.isArray(conversations) ? conversations : [];
  elements.aiHistory.replaceChildren();
  for (const conversation of state.aiConversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.aiConversation = conversation.lago_id;
    button.classList.toggle("active", conversation.lago_id === state.activeAiConversationId);
    const title = document.createElement("strong");
    title.textContent = conversation.title;
    const date = document.createElement("small");
    date.textContent = formatDate(conversation.updated_at);
    button.append(title, date);
    elements.aiHistory.append(button);
  }
}

function openAiPanel() {
  document.querySelector(".app-shell").classList.add("ai-open");
  elements.aiPanel.hidden = false;
  elements.openAiPanel.setAttribute("aria-expanded", "true");
  elements.aiPrompt.focus();
}

function closeAiPanel() {
  document.querySelector(".app-shell").classList.remove("ai-open");
  elements.aiPanel.hidden = true;
  elements.openAiPanel.setAttribute("aria-expanded", "false");
}

async function selectAiConversation(event) {
  const button = event.target.closest("button[data-ai-conversation]");
  if (!button) return;
  try {
    const payload = await requestJson(aiConversationEndpoint(button.dataset.aiConversation));
    state.activeAiConversationId = payload.conversation.lago_id;
    state.aiMessages = payload.conversation.messages ?? [];
    renderAiMessages();
    renderAiHistory(state.aiConversations);
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

function renderAiMessages() {
  elements.aiMessages.replaceChildren();
  if (state.aiMessages.length === 0) {
    const welcome = document.createElement("div");
    welcome.className = "ai-welcome";
    const title = document.createElement("strong");
    title.textContent = "Ask about your billing operation";
    const copy = document.createElement("p");
    copy.textContent = "I can explain tenant-scoped totals and suggest read-only follow-ups.";
    welcome.append(title, copy);
    elements.aiMessages.append(welcome);
    return;
  }
  for (const message of state.aiMessages) appendAiMessage(message.role, message.content);
  elements.aiMessages.scrollTop = elements.aiMessages.scrollHeight;
}

function appendAiMessage(role, content) {
  const message = document.createElement("div");
  message.className = `ai-message ${role}`;
  const label = document.createElement("strong");
  label.textContent = role === "assistant" ? "Lago Assistant" : "You";
  const copy = document.createElement("p");
  copy.textContent = content;
  message.append(label, copy);
  elements.aiMessages.append(message);
  return copy;
}

function useAiShortcut(event) {
  const button = event.target.closest("button[data-ai-shortcut]");
  if (!button) return;
  elements.aiPrompt.value = button.dataset.aiShortcut;
  elements.aiPrompt.focus();
}

async function submitAiMessage(event) {
  event.preventDefault();
  const content = elements.aiPrompt.value.trim();
  if (!content) return;
  setBusy(elements.sendAiMessage, true, "Thinking…");
  elements.aiPrompt.value = "";
  try {
    if (!state.activeAiConversationId) {
      const created = await requestJson(endpoints.aiConversations, {
        method: "POST",
        body: { conversation: { title: content.slice(0, 80) } },
      });
      state.activeAiConversationId = created.conversation.lago_id;
      state.aiConversations.unshift(created.conversation);
    }
    state.aiMessages.push({ role: "user", content });
    appendAiMessage("user", content);
    const assistantCopy = appendAiMessage("assistant", "");
    const response = await fetch(aiMessagesEndpoint(state.activeAiConversationId), {
      method: "POST",
      headers: operatorHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
      body: JSON.stringify({ message: { content } }),
    });
    if (!response.ok) throw await apiErrorFromResponse(response);
    assistantCopy.textContent = await readAiStream(response, assistantCopy);
    state.aiMessages.push({ role: "assistant", content: assistantCopy.textContent });
    const history = await requestJson(`${endpoints.aiConversations}?limit=3`);
    renderAiHistory(history.conversations);
  } catch (error) {
    showPageError(errorMessage(error));
  } finally {
    setBusy(elements.sendAiMessage, false, "Send");
  }
}

async function readAiStream(response, target) {
  if (!response.body) return "The assistant returned an empty response.";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        if (typeof parsed.response === "string") content += parsed.response;
      } catch {
        continue;
      }
    }
    target.textContent = content;
    elements.aiMessages.scrollTop = elements.aiMessages.scrollHeight;
    if (done) break;
  }
  return content || "The assistant returned an empty response.";
}

function operatorHeaders(values = {}) {
  const headers = new Headers(values);
  headers.set("X-Operator-Request", "1");
  if (state.organizationSlug) headers.set("X-Operator-Organization", state.organizationSlug);
  return headers;
}

async function apiErrorFromResponse(response) {
  try {
    const payload = await response.json();
    return new ApiRequestError(response.status, payload.code, payload.message);
  } catch {
    return new ApiRequestError(response.status, "invalid_response", "Invalid response");
  }
}

function privilegeSummary(privileges) {
  if (!Array.isArray(privileges) || privileges.length === 0) return "No privileges";
  return privileges
    .map((privilege) => `${privilege.code} (${humanize(privilege.value_type)})`)
    .join(", ");
}

function humanize(value) {
  return safeText(value, "—")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

async function handleEntityDetailNavigation(event) {
  const link = event.target.closest("a[data-entity-detail-route]");
  if (!link) return;
  event.preventDefault();
  const route = link.dataset.entityDetailRoute;
  const identifier = link.dataset.entityDetailId;
  if (!entityDetailDefinitions[route] || !identifier) return;
  if (route === "features") {
    try {
      const payload = await requestJson(featureEndpoint(identifier));
      const feature = state.features.find((item) => item.lago_id === identifier);
      if (feature) Object.assign(feature, payload.feature);
    } catch (error) {
      showPageError(errorMessage(error));
      return;
    }
  }
  if (route === "features" || route === "billable-metrics") {
    try {
      const item =
        route === "features"
          ? state.features.find((candidate) => candidate.lago_id === identifier)
          : state.billableMetrics.find((candidate) => candidate.code === identifier);
      const payload = await requestJson(catalogActivityEndpoint(route, identifier));
      if (item) item.activity_logs = payload.activity_logs ?? [];
    } catch (error) {
      showPageError(errorMessage(error));
      return;
    }
  }
  if (route === "webhook-endpoints") {
    try {
      const item = state.webhookEndpoints.find((candidate) => candidate.lago_id === identifier);
      const payload = await requestJson(webhookLogsEndpoint(identifier));
      if (item) item.webhook_logs = payload.webhook_logs ?? [];
    } catch (error) {
      showPageError(errorMessage(error));
      return;
    }
  }
  state.route = route;
  state.detailId = identifier;
  state.detailTab = "overview";
  window.history.pushState(
    { route, identifier },
    "",
    routePath(state.organizationSlug, route, identifier),
  );
  renderRoute();
  closeMobileNavigation();
}

function navigateToEntityDetail(route, identifier, { replace = false } = {}) {
  if (!entityDetailDefinitions[route] || !identifier) return;
  state.route = route;
  state.detailId = String(identifier);
  state.detailTab = "overview";
  const path = routePath(state.organizationSlug, route, state.detailId);
  if (replace) window.history.replaceState({ route, identifier }, "", path);
  else window.history.pushState({ route, identifier }, "", path);
  renderRoute();
  closeMobileNavigation();
}

async function hydrateSelectedCatalogDetail() {
  if (state.route === "webhook-endpoints" && state.detailId) {
    const item = state.webhookEndpoints.find((candidate) => candidate.lago_id === state.detailId);
    if (!item) return;
    const payload = await requestJson(webhookLogsEndpoint(state.detailId));
    item.webhook_logs = payload.webhook_logs ?? [];
    return;
  }
  if (!new Set(["features", "billable-metrics"]).has(state.route) || !state.detailId) return;
  const item =
    state.route === "features"
      ? state.features.find((candidate) => candidate.lago_id === state.detailId)
      : state.billableMetrics.find((candidate) => candidate.code === state.detailId);
  if (!item) return;
  if (state.route === "features" && !Array.isArray(item.privileges)) {
    const payload = await requestJson(featureEndpoint(state.detailId));
    Object.assign(item, payload.feature);
  }
  const activityPayload = await requestJson(catalogActivityEndpoint(state.route, state.detailId));
  item.activity_logs = activityPayload.activity_logs ?? [];
}

function findDetailEntity(definition, identifier) {
  if (!definition || !identifier) return null;
  const collection = state[definition.collection];
  if (!Array.isArray(collection)) return null;
  return collection.find((item) => String(definition.id(item)) === String(identifier)) ?? null;
}

function renderEntityDetail() {
  const definition = entityDetailDefinitions[state.route];
  const item = findDetailEntity(definition, state.detailId);
  const routeDefinition = routeDefinitions[state.route];
  elements.entityDetailBackLabel.textContent = routeDefinition?.title ?? "Back";
  elements.entityDetailFields.replaceChildren();
  elements.entityDetailMissing.hidden = Boolean(item);
  elements.entityDetailEdit.hidden = true;
  elements.entityDownloadDocument.hidden = true;
  elements.entityAlerts.hidden = true;
  elements.entityAdvanced.hidden = true;
  elements.entityAdvancedContent.replaceChildren();
  elements.entityAlertsBody.replaceChildren();

  if (!item) {
    elements.entityDetailAvatar.textContent = "—";
    elements.entityDetailType.textContent = definition?.singular ?? "Billing object";
    elements.entityDetailName.textContent = "Billing object not found";
    elements.entityDetailId.textContent = safeText(state.detailId, "—");
    return;
  }

  const label = definition.label(item);
  elements.entityDetailAvatar.textContent = initials(label);
  elements.entityDetailType.textContent = definition.singular;
  elements.entityDetailName.textContent = label;
  elements.entityDetailId.textContent = safeText(definition.id(item), "—");
  elements.entityDetailEdit.hidden =
    state.role !== "admin" || typeof definition.edit !== "function";

  for (const [fieldLabel, valueReader] of definition.fields) {
    const group = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = fieldLabel;
    description.textContent = detailValue(valueReader(item));
    group.append(term, description);
    elements.entityDetailFields.append(group);
  }
  if (state.route === "subscriptions" || state.route === "wallets") {
    void renderEntityAlerts(item);
  }
  if (new Set(["subscriptions", "invoices", "credit-notes", "payment-receipts"]).has(state.route)) {
    void renderEntityAdvanced(item);
  }
}

async function renderEntityAdvanced(item) {
  const route = state.route;
  const detailId = state.detailId;
  elements.entityAdvanced.hidden = false;
  elements.entityAdvancedTitle.textContent =
    route === "subscriptions"
      ? "Progressive billing"
      : route === "invoices"
        ? "Invoice controls"
        : route === "credit-notes"
          ? "Credit note controls"
          : "Receipt document";
  elements.entityAdvancedCopy.textContent =
    route === "subscriptions"
      ? "Control threshold-based progressive billing for this subscription."
      : route === "invoices"
        ? "Manage metadata, payment state, PDF generation, and voided-invoice regeneration."
        : route === "credit-notes"
          ? "Edit internal note details and generate the retained PDF artifact."
          : "Download the generated payment receipt PDF.";
  elements.entityDownloadDocument.hidden = route === "subscriptions";
  const loading = document.createElement("div");
  loading.className = "table-loading compact";
  loading.textContent = "Loading billing controls…";
  elements.entityAdvancedContent.replaceChildren(loading);
  if (route === "payment-receipts") {
    loading.remove();
    const copy = document.createElement("p");
    copy.className = "muted";
    copy.textContent =
      "PDF generation remains inside the Cloudflare document workflow and artifact bucket.";
    elements.entityAdvancedContent.append(copy);
    return;
  }
  try {
    if (route === "subscriptions") {
      const payload = await requestJson(
        `${subscriptionEndpoint(item.external_id)}/progressive-billing`,
      );
      if (state.route !== route || state.detailId !== detailId) return;
      loading.remove();
      renderSubscriptionProgressiveBilling(item, payload.progressive_billing);
      return;
    }
    if (route === "credit-notes") {
      loading.remove();
      renderCreditNoteAdvanced(item);
      return;
    }
    const [invoicePayload, metadataPayload, adjustedPayload] = await Promise.all([
      requestJson(invoiceEndpoint(item.lago_id)),
      requestJson(invoiceMetadataEndpoint(item.lago_id)),
      requestJson(invoiceAdjustedFeesEndpoint(item.lago_id)),
    ]);
    if (state.route !== route || state.detailId !== detailId) return;
    loading.remove();
    renderInvoiceAdvanced(
      invoicePayload.invoice ?? item,
      metadataPayload.metadata ?? [],
      adjustedPayload.adjusted_fees ?? [],
    );
  } catch (error) {
    loading.className = "form-error inline-error";
    loading.textContent = errorMessage(error);
  }
}

function renderSubscriptionProgressiveBilling(subscription, progressiveBilling) {
  const form = document.createElement("form");
  form.className = "advanced-inline-form";
  const disabled = document.createElement("label");
  disabled.className = "checkbox-field";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = progressiveBilling?.disabled === true;
  const copy = document.createElement("span");
  copy.textContent = "Disable progressive billing for this subscription";
  disabled.append(checkbox, copy);
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "secondary-button";
  reset.textContent = "Reset to enabled";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary-button";
  save.textContent = "Save progressive billing";
  const error = document.createElement("p");
  error.className = "form-error";
  error.hidden = true;
  if (state.role !== "admin") {
    checkbox.disabled = true;
    reset.hidden = true;
    save.hidden = true;
  }
  const endpoint = `${subscriptionEndpoint(subscription.external_id)}/progressive-billing`;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(save, true, "Saving…");
    try {
      await requestJson(endpoint, {
        method: "PUT",
        body: { progressive_billing: { disabled: checkbox.checked } },
      });
      error.hidden = true;
    } catch (requestError) {
      error.textContent = errorMessage(requestError);
      error.hidden = false;
    } finally {
      setBusy(save, false, "Save progressive billing");
    }
  });
  reset.addEventListener("click", async () => {
    setBusy(reset, true, "Resetting…");
    try {
      await requestJson(endpoint, { method: "DELETE" });
      checkbox.checked = false;
      error.hidden = true;
    } catch (requestError) {
      error.textContent = errorMessage(requestError);
      error.hidden = false;
    } finally {
      setBusy(reset, false, "Reset to enabled");
    }
  });
  actions.append(reset, save);
  form.append(disabled, actions, error);
  elements.entityAdvancedContent.append(form);
}

function renderInvoiceAdvanced(invoice, metadata, adjustedFees) {
  const metadataBlock = document.createElement("section");
  metadataBlock.className = "advanced-control-block";
  const metadataTitle = document.createElement("h3");
  metadataTitle.textContent = "Invoice metadata";
  const metadataCopy = document.createElement("p");
  metadataCopy.textContent =
    "Keep purchase-order references and internal billing context on the invoice.";
  const metadataRows = document.createElement("div");
  const addMetadata = document.createElement("button");
  addMetadata.type = "button";
  addMetadata.className = "secondary-button";
  addMetadata.textContent = "Add metadata";
  const saveMetadata = document.createElement("button");
  saveMetadata.type = "button";
  saveMetadata.className = "primary-button";
  saveMetadata.textContent = "Save metadata";
  const metadataError = document.createElement("p");
  metadataError.className = "form-error";
  metadataError.hidden = true;
  const appendMetadataRow = (entry = {}) => {
    const row = document.createElement("div");
    row.className = "metadata-editor-row";
    const key = document.createElement("input");
    key.type = "text";
    key.maxLength = 64;
    key.placeholder = "Key";
    key.value = safeText(entry.key, "");
    const value = document.createElement("input");
    value.type = "text";
    value.maxLength = 512;
    value.placeholder = "Value";
    value.value = safeText(entry.value, "");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button danger";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => row.remove());
    if (state.role !== "admin") for (const control of [key, value, remove]) control.disabled = true;
    row.append(key, value, remove);
    metadataRows.append(row);
  };
  for (const entry of metadata) appendMetadataRow(entry);
  if (!metadata.length) appendMetadataRow();
  addMetadata.hidden = state.role !== "admin";
  saveMetadata.hidden = state.role !== "admin";
  addMetadata.addEventListener("click", () => appendMetadataRow());
  saveMetadata.addEventListener("click", async () => {
    const rows = Array.from(metadataRows.querySelectorAll(".metadata-editor-row"));
    const next = rows
      .map((row) => ({
        key: row.querySelector("input:nth-of-type(1)").value.trim(),
        value: row.querySelector("input:nth-of-type(2)").value.trim(),
      }))
      .filter((entry) => entry.key || entry.value);
    setBusy(saveMetadata, true, "Saving…");
    try {
      const payload = await requestJson(invoiceMetadataEndpoint(invoice.lago_id), {
        method: "PUT",
        body: { metadata: next },
      });
      metadataRows.replaceChildren();
      for (const entry of payload.metadata ?? []) appendMetadataRow(entry);
      if (!payload.metadata?.length) appendMetadataRow();
      metadataError.hidden = true;
    } catch (error) {
      metadataError.textContent = errorMessage(error);
      metadataError.hidden = false;
    } finally {
      setBusy(saveMetadata, false, "Save metadata");
    }
  });
  const metadataActions = document.createElement("div");
  metadataActions.className = "row-actions";
  metadataActions.append(addMetadata, saveMetadata);
  metadataBlock.append(metadataTitle, metadataCopy, metadataRows, metadataActions, metadataError);

  const paymentBlock = document.createElement("section");
  paymentBlock.className = "advanced-control-block";
  const paymentTitle = document.createElement("h3");
  paymentTitle.textContent = "Payment status";
  const paymentCopy = document.createElement("p");
  paymentCopy.textContent =
    "Record the operator-visible state without invoking a payment provider.";
  const paymentForm = document.createElement("form");
  paymentForm.className = "advanced-inline-form";
  const paymentSelect = labeledSelect("Status", [
    ["pending", "Pending"],
    ["requires_action", "Requires action"],
    ["succeeded", "Succeeded"],
    ["failed", "Failed"],
    ["refunded", "Refunded"],
  ]);
  paymentSelect.select.value = invoice.payment_status;
  const paymentSave = document.createElement("button");
  paymentSave.type = "submit";
  paymentSave.className = "primary-button";
  paymentSave.textContent = "Update payment status";
  const paymentError = document.createElement("p");
  paymentError.className = "form-error";
  paymentError.hidden = true;
  if (state.role !== "admin" || invoice.status !== "finalized") {
    paymentSelect.select.disabled = true;
    paymentSave.hidden = true;
  }
  paymentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(paymentSave, true, "Saving…");
    try {
      await requestJson(`${invoiceEndpoint(invoice.lago_id)}/payment-status`, {
        method: "PUT",
        body: { invoice: { payment_status: paymentSelect.select.value } },
      });
      const selected = state.invoices.find((candidate) => candidate.lago_id === invoice.lago_id);
      if (selected) selected.payment_status = paymentSelect.select.value;
      paymentError.hidden = true;
    } catch (error) {
      paymentError.textContent = errorMessage(error);
      paymentError.hidden = false;
    } finally {
      setBusy(paymentSave, false, "Update payment status");
    }
  });
  paymentForm.append(paymentSelect.label, paymentSave, paymentError);
  paymentBlock.append(paymentTitle, paymentCopy, paymentForm);

  const regenerationBlock = document.createElement("section");
  regenerationBlock.className = "advanced-control-block";
  const regenerationTitle = document.createElement("h3");
  regenerationTitle.textContent = "Adjusted fees and regeneration";
  const regenerationCopy = document.createElement("p");
  regenerationCopy.textContent =
    "Preview and stage corrected fee values, then regenerate a voided invoice as a new draft.";
  const feeForm = document.createElement("form");
  feeForm.className = "advanced-inline-form";
  const feeSelect = labeledSelect(
    "Invoice fee",
    (invoice.fees ?? []).map((fee) => [
      fee.lago_id,
      safeText(fee.invoice_display_name, fee.description),
    ]),
  );
  const units = labeledInput("Units", "number", "1");
  units.input.min = "0";
  units.input.step = "0.000000001";
  const amount = labeledInput("Unit amount (minor)", "number", "0");
  amount.input.min = "0";
  amount.input.step = "0.000000001";
  const description = labeledInput("Description", "text", "");
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "secondary-button";
  preview.textContent = "Preview adjustment";
  const stage = document.createElement("button");
  stage.type = "submit";
  stage.className = "primary-button";
  stage.textContent = "Stage adjustment";
  const regenerate = document.createElement("button");
  regenerate.type = "button";
  regenerate.className = "primary-button";
  regenerate.textContent = "Regenerate draft invoice";
  regenerate.hidden = state.role !== "admin" || invoice.status !== "voided";
  const feeResult = document.createElement("p");
  feeResult.className = "muted";
  feeResult.textContent = adjustedFees.length
    ? `${adjustedFees.length} adjusted fee${adjustedFees.length === 1 ? "" : "s"} staged.`
    : "No adjusted fees are staged.";
  const feeError = document.createElement("p");
  feeError.className = "form-error";
  feeError.hidden = true;
  const adjustmentBody = () => ({
    adjusted_fee: {
      invoice_line_id: feeSelect.select.value || null,
      description: optionalFormValue(description.input.value),
      units: units.input.value,
      unit_amount_cents: amount.input.value,
    },
  });
  preview.addEventListener("click", async () => {
    try {
      const payload = await requestJson(`${invoiceAdjustedFeesEndpoint(invoice.lago_id)}/preview`, {
        method: "POST",
        body: adjustmentBody(),
      });
      feeResult.textContent = `Preview: ${formatMoney(payload.adjusted_fee.amount_cents, invoice.currency)}.`;
      feeError.hidden = true;
    } catch (error) {
      feeError.textContent = errorMessage(error);
      feeError.hidden = false;
    }
  });
  feeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(stage, true, "Staging…");
    try {
      const payload = await requestJson(invoiceAdjustedFeesEndpoint(invoice.lago_id), {
        method: "POST",
        body: adjustmentBody(),
      });
      feeResult.textContent = `${payload.adjusted_fees?.length ?? 0} adjusted fee${payload.adjusted_fees?.length === 1 ? "" : "s"} staged.`;
      feeError.hidden = true;
    } catch (error) {
      feeError.textContent = errorMessage(error);
      feeError.hidden = false;
    } finally {
      setBusy(stage, false, "Stage adjustment");
    }
  });
  regenerate.addEventListener("click", async () => {
    setBusy(regenerate, true, "Regenerating…");
    try {
      const payload = await requestJson(`${invoiceEndpoint(invoice.lago_id)}/regenerate`, {
        method: "POST",
        body: {},
      });
      await refreshInvoices();
      navigateToEntityDetail("invoices", payload.invoice.lago_id);
    } catch (error) {
      feeError.textContent = errorMessage(error);
      feeError.hidden = false;
      setBusy(regenerate, false, "Regenerate draft invoice");
    }
  });
  if (state.role !== "admin" || !(invoice.fees ?? []).length) {
    for (const control of feeForm.querySelectorAll("input, select, button"))
      control.disabled = true;
  }
  const feeActions = document.createElement("div");
  feeActions.className = "row-actions";
  feeActions.append(preview, stage, regenerate);
  feeForm.append(
    feeSelect.label,
    units.label,
    amount.label,
    description.label,
    feeActions,
    feeResult,
    feeError,
  );
  regenerationBlock.append(regenerationTitle, regenerationCopy, feeForm);
  elements.entityAdvancedContent.append(metadataBlock, paymentBlock, regenerationBlock);
}

function renderCreditNoteAdvanced(creditNote) {
  const form = document.createElement("form");
  form.className = "advanced-inline-form";
  const reason = labeledSelect("Reason", [
    ["duplicated_charge", "Duplicated charge"],
    ["product_unsatisfactory", "Product unsatisfactory"],
    ["order_change", "Order change"],
    ["order_cancellation", "Order cancellation"],
    ["fraudulent_charge", "Fraudulent charge"],
    ["other", "Other"],
  ]);
  reason.select.value = creditNote.reason;
  const description = labeledInput("Description", "text", safeText(creditNote.description, ""));
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary-button";
  save.textContent = "Save credit note";
  const error = document.createElement("p");
  error.className = "form-error";
  error.hidden = true;
  if (state.role !== "admin") {
    reason.select.disabled = true;
    description.input.disabled = true;
    save.hidden = true;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(save, true, "Saving…");
    try {
      const payload = await requestJson(creditNoteEndpoint(creditNote.lago_id), {
        method: "PUT",
        body: {
          credit_note: {
            reason: reason.select.value,
            description: optionalFormValue(description.input.value),
          },
        },
      });
      Object.assign(creditNote, payload.credit_note);
      error.hidden = true;
    } catch (requestError) {
      error.textContent = errorMessage(requestError);
      error.hidden = false;
    } finally {
      setBusy(save, false, "Save credit note");
    }
  });
  form.append(reason.label, description.label, save, error);
  elements.entityAdvancedContent.append(form);
}

async function downloadSelectedDocument() {
  const definition = entityDetailDefinitions[state.route];
  const item = findDetailEntity(definition, state.detailId);
  if (!item) return;
  const path =
    state.route === "invoices"
      ? `${invoiceEndpoint(item.lago_id)}/download`
      : state.route === "credit-notes"
        ? `${creditNoteEndpoint(item.lago_id)}/download`
        : `${endpoints.paymentReceipts}/${encodeURIComponent(item.lago_id)}/download`;
  setBusy(elements.entityDownloadDocument, true, "Preparing…");
  try {
    const headers = new Headers();
    if (state.organizationSlug) headers.set("X-Operator-Organization", state.organizationSlug);
    const response = await fetch(path, { headers });
    if (response.status === 202) {
      elements.entityAdvancedCopy.textContent =
        "The PDF is generating in the Cloudflare document workflow. Try download again in a moment.";
      return;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new ApiRequestError(
        response.status,
        payload.code,
        payload.message ?? "Document download failed",
      );
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = documentFilename(response.headers.get("Content-Disposition"), state.route);
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    showPageError(errorMessage(error));
  } finally {
    setBusy(elements.entityDownloadDocument, false, "Download PDF");
  }
}

async function renderEntityAlerts(item) {
  const route = state.route;
  const detailId = state.detailId;
  const resourceType = route === "subscriptions" ? "subscription" : "wallet";
  const resourceId = route === "subscriptions" ? item.external_id : item.lago_id;
  elements.entityAlerts.hidden = false;
  elements.entityAlertsLoading.textContent = "Loading alerts…";
  elements.entityAlertsLoading.hidden = false;
  elements.entityAlertsEmpty.hidden = true;
  elements.entityAlertsTableShell.hidden = true;
  elements.openCreateAlert.hidden = state.role !== "admin";
  try {
    const query = new URLSearchParams({
      resource_type: resourceType,
      resource_id: resourceId,
    });
    const payload = await requestJson(`${endpoints.alerts}?${query}`);
    if (state.route !== route || state.detailId !== detailId) return;
    state.entityAlerts = Array.isArray(payload.alerts) ? payload.alerts : [];
    elements.entityAlertsBody.replaceChildren();
    for (const alert of state.entityAlerts) elements.entityAlertsBody.append(createAlertRow(alert));
    elements.entityAlertsLoading.hidden = true;
    elements.entityAlertsEmpty.hidden = state.entityAlerts.length !== 0;
    elements.entityAlertsTableShell.hidden = state.entityAlerts.length === 0;
  } catch (error) {
    elements.entityAlertsLoading.textContent = errorMessage(error);
  }
}

function createAlertRow(alert) {
  const row = document.createElement("tr");
  const name = document.createElement("td");
  const label = document.createElement("span");
  label.className = "key-name";
  label.textContent = safeText(alert.name, humanize(alert.code));
  const code = document.createElement("span");
  code.className = "key-id";
  code.textContent = alert.code;
  name.append(label, code);
  const type = document.createElement("td");
  type.textContent = humanize(alert.alert_type);
  const thresholds = document.createElement("td");
  thresholds.textContent = (alert.thresholds ?? [])
    .map((threshold) => `${threshold.value}${threshold.recurring ? " recurring" : ""}`)
    .join(", ");
  const actions = document.createElement("td");
  actions.className = "actions-column";
  if (state.role === "admin") {
    const group = document.createElement("div");
    group.className = "row-actions";
    for (const [action, text, dangerous] of [
      ["edit", "Edit", false],
      ["delete", "Delete", true],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = dangerous ? "row-action danger" : "row-action";
      button.dataset.alertAction = action;
      button.dataset.alertId = alert.lago_id;
      button.textContent = text;
      group.append(button);
    }
    actions.append(group);
  } else {
    actions.textContent = "Read only";
    actions.classList.add("muted");
  }
  row.append(name, type, thresholds, actions);
  return row;
}

function handleAlertAction(event) {
  const button = event.target.closest("button[data-alert-action]");
  if (!button || state.role !== "admin") return;
  const alert = state.entityAlerts.find(
    (candidate) => candidate.lago_id === button.dataset.alertId,
  );
  if (!alert) return;
  if (button.dataset.alertAction === "edit") {
    openEditAlertDialog(alert);
    return;
  }
  state.confirmMode = "delete-alert";
  state.selectedAlertId = alert.lago_id;
  elements.confirmError.hidden = true;
  elements.confirmTitle.textContent = "Delete alert?";
  elements.confirmCopy.textContent = `Deleting “${safeText(alert.name, alert.code)}” stops evaluating this threshold.`;
  elements.confirmAction.textContent = "Delete alert";
  elements.confirmDialog.showModal();
}

function openCreateAlertDialog() {
  const item = findDetailEntity(entityDetailDefinitions[state.route], state.detailId);
  if (!item || (state.route !== "subscriptions" && state.route !== "wallets")) return;
  state.alertFormMode = "create";
  state.selectedAlertId = null;
  elements.alertForm.reset();
  configureAlertSelects(state.route === "subscriptions" ? "subscription" : "wallet");
  elements.alertTitle.textContent = "Create alert";
  elements.submitAlert.textContent = "Create alert";
  elements.alertError.hidden = true;
  elements.alertDialog.showModal();
  elements.alertName.focus();
}

function openEditAlertDialog(alert) {
  state.alertFormMode = "edit";
  state.selectedAlertId = alert.lago_id;
  configureAlertSelects(alert.resource_type);
  elements.alertName.value = safeText(alert.name, "");
  elements.alertCode.value = alert.code;
  elements.alertType.value = alert.alert_type;
  elements.alertType.disabled = true;
  elements.alertMetric.value = alert.billable_metric_id ?? "";
  elements.alertThreshold.value = alert.thresholds?.[0]?.value ?? "";
  elements.alertRecurring.checked = Boolean(alert.thresholds?.[0]?.recurring);
  elements.alertTitle.textContent = "Edit alert";
  elements.submitAlert.textContent = "Save alert";
  elements.alertError.hidden = true;
  updateAlertMetricAvailability();
  elements.alertDialog.showModal();
  elements.alertName.focus();
  elements.alertName.select();
}

function configureAlertSelects(resourceType) {
  const types =
    resourceType === "wallet"
      ? [
          "wallet_balance_amount",
          "wallet_credits_balance",
          "wallet_ongoing_balance_amount",
          "wallet_credits_ongoing_balance",
        ]
      : [
          "current_usage_amount",
          "lifetime_usage_amount",
          "billable_metric_current_usage_amount",
          "billable_metric_current_usage_units",
          "billable_metric_lifetime_usage_units",
        ];
  replaceSelectOptions(elements.alertType, types, (value) => value, humanize);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Not applicable";
  elements.alertMetric.replaceChildren(placeholder);
  for (const metric of state.billableMetrics) {
    const option = document.createElement("option");
    option.value = metric.lago_id;
    option.textContent = `${safeText(metric.name, metric.code)} (${metric.code})`;
    elements.alertMetric.append(option);
  }
  elements.alertType.disabled = false;
  elements.alertType.onchange = updateAlertMetricAvailability;
  updateAlertMetricAvailability();
}

function updateAlertMetricAvailability() {
  const required = elements.alertType.value.startsWith("billable_metric_");
  elements.alertMetric.disabled = !required;
  elements.alertMetric.required = required;
  if (!required) elements.alertMetric.value = "";
}

async function submitAlertForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.alertDialog.close();
    return;
  }
  if (!elements.alertForm.reportValidity()) return;
  const item = findDetailEntity(entityDetailDefinitions[state.route], state.detailId);
  if (!item) return;
  const creating = state.alertFormMode === "create";
  const resourceType = state.route === "subscriptions" ? "subscription" : "wallet";
  const alert = {
    billable_metric_id: elements.alertMetric.value || null,
    code: elements.alertCode.value.trim(),
    name: optionalFormValue(elements.alertName.value),
    thresholds: [
      { value: elements.alertThreshold.value.trim(), recurring: elements.alertRecurring.checked },
    ],
  };
  if (creating) {
    alert.resource_type = resourceType;
    alert.resource_id = resourceType === "subscription" ? item.external_id : item.lago_id;
    alert.alert_type = elements.alertType.value;
  }
  const body = { alert };
  setBusy(elements.submitAlert, true, creating ? "Creating…" : "Saving…");
  elements.alertError.hidden = true;
  try {
    await requestJson(creating ? endpoints.alerts : alertEndpoint(state.selectedAlertId), {
      method: creating ? "POST" : "PUT",
      body,
    });
    elements.alertDialog.close();
    await renderEntityAlerts(item);
  } catch (error) {
    elements.alertError.textContent = errorMessage(error);
    elements.alertError.hidden = false;
  } finally {
    setBusy(elements.submitAlert, false, creating ? "Create alert" : "Save alert");
  }
}

function openSelectedEntityEditor() {
  if (state.role !== "admin") return;
  const definition = entityDetailDefinitions[state.route];
  const item = findDetailEntity(definition, state.detailId);
  if (item && typeof definition.edit === "function") definition.edit(item);
}

function detailValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "—";
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function renderObservability(activityLogs, apiLogs, events) {
  state.activityLogs = Array.isArray(activityLogs) ? activityLogs : [];
  state.apiLogs = Array.isArray(apiLogs) ? apiLogs : [];
  state.events = Array.isArray(events) ? events : [];
  renderObservabilityTable(
    "activity-logs",
    state.activityLogs,
    elements.activityLogsEmpty,
    elements.activityLogsTableShell,
    elements.activityLogsTableBody,
    (item) => [
      humanize(item.event_type),
      `${safeText(item.resource_type, "resource")} · ${safeText(item.resource_id, "—")}`,
      item.version,
      humanize(item.delivery_status),
      formatDate(item.occurred_at),
    ],
  );
  renderObservabilityTable(
    "api-logs",
    state.apiLogs,
    elements.apiLogsEmpty,
    elements.apiLogsTableShell,
    elements.apiLogsTableBody,
    (item) => [
      item.request_id,
      item.method,
      item.path,
      item.status,
      `${item.duration_ms} ms`,
      formatDate(item.occurred_at),
    ],
  );
  renderObservabilityTable(
    "events",
    state.events,
    elements.eventsEmpty,
    elements.eventsTableShell,
    elements.eventsTableBody,
    (item) => [
      item.transaction_id,
      item.code,
      item.external_subscription_id,
      formatDate(item.timestamp),
      formatDate(item.received_at),
    ],
  );
}

function renderObservabilityTable(route, items, empty, shell, body, cellsFor) {
  body.replaceChildren();
  empty.hidden = items.length !== 0;
  shell.hidden = items.length === 0;
  const definition = entityDetailDefinitions[route];
  for (const item of items) {
    const row = document.createElement("tr");
    for (const value of cellsFor(item)) {
      const cell = document.createElement("td");
      cell.textContent = detailValue(value);
      row.append(cell);
    }
    body.append(row);
  }
  decorateEntityRows(body, items, route);
  if (!definition) body.replaceChildren();
}

function renderTeamSecurity(members, invitations, roles, authentication) {
  state.teamMembers = Array.isArray(members) ? members : [];
  state.teamInvitations = Array.isArray(invitations) ? invitations : [];
  state.teamRoles = Array.isArray(roles) ? roles : [];
  state.teamAuthentication = authentication ?? null;
  elements.openTeamInvite.hidden = state.role !== "admin";
  renderTeamRows();
  elements.teamAuthentication.replaceChildren();
  for (const [label, value] of [
    ["Provider", "Cloudflare Access"],
    ["Enforced", authentication?.enforced ? "Yes" : "No"],
    ["Password login", authentication?.password_login ? "Enabled" : "Disabled"],
    ["Configuration", authentication?.sso_configuration],
  ]) {
    const group = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = detailValue(value);
    group.append(term, description);
    elements.teamAuthentication.append(group);
  }
  elements.teamRoles.replaceChildren();
  for (const role of state.teamRoles) {
    const item = document.createElement("div");
    const title = document.createElement("strong");
    const copy = document.createElement("p");
    title.textContent = role.name;
    copy.textContent = role.description;
    item.append(title, copy);
    elements.teamRoles.append(item);
  }
}

function renderTeamRows() {
  elements.teamMembersBody.replaceChildren();
  for (const member of state.teamMembers) {
    const row = teamBaseRow([
      member.identity,
      humanize(member.role),
      humanize(member.status),
      formatDate(member.created_at),
    ]);
    const actions = document.createElement("td");
    if (
      state.role === "admin" &&
      member.status === "active" &&
      member.lago_id !== state.currentMembershipId
    ) {
      const role = teamRoleSelect(member.role, "memberRole", member.lago_id);
      const revoke = teamActionButton("Revoke", "memberRevoke", member.lago_id);
      actions.append(role, revoke);
    } else
      actions.textContent = member.lago_id === state.currentMembershipId ? "Current session" : "—";
    row.append(actions);
    elements.teamMembersBody.append(row);
  }
  elements.teamInvitationsBody.replaceChildren();
  for (const invitation of state.teamInvitations) {
    const row = teamBaseRow([
      invitation.identity,
      humanize(invitation.role),
      humanize(invitation.status),
      formatDate(invitation.expires_at),
    ]);
    const actions = document.createElement("td");
    if (state.role === "admin" && invitation.status === "pending") {
      actions.append(
        teamRoleSelect(invitation.role, "invitationRole", invitation.lago_id),
        teamActionButton("Revoke", "invitationRevoke", invitation.lago_id),
      );
    } else actions.textContent = "—";
    row.append(actions);
    elements.teamInvitationsBody.append(row);
  }
}

function teamBaseRow(values) {
  const row = document.createElement("tr");
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = detailValue(value);
    row.append(cell);
  }
  return row;
}

function teamRoleSelect(value, key, id) {
  const select = document.createElement("select");
  select.dataset[key] = id;
  for (const code of ["viewer", "admin"]) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = humanize(code);
    option.selected = code === value;
    select.append(option);
  }
  return select;
}

function teamActionButton(label, key, id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  button.dataset[key] = id;
  button.textContent = label;
  return button;
}

async function updateTeamMemberRole(event) {
  if (!event.target.dataset.memberRole) return;
  await mutateTeam(
    `${endpoints.teamMembers}/${encodeURIComponent(event.target.dataset.memberRole)}`,
    "PATCH",
    { role: event.target.value },
  );
}
async function revokeTeamMember(event) {
  const button = event.target.closest("button[data-member-revoke]");
  if (!button) return;
  await mutateTeam(
    `${endpoints.teamMembers}/${encodeURIComponent(button.dataset.memberRevoke)}`,
    "DELETE",
  );
}
async function updateTeamInvitationRole(event) {
  if (!event.target.dataset.invitationRole) return;
  await mutateTeam(
    `${endpoints.teamInvitations}/${encodeURIComponent(event.target.dataset.invitationRole)}`,
    "PATCH",
    { role: event.target.value },
  );
}
async function revokeTeamInvitation(event) {
  const button = event.target.closest("button[data-invitation-revoke]");
  if (!button) return;
  await mutateTeam(
    `${endpoints.teamInvitations}/${encodeURIComponent(button.dataset.invitationRevoke)}`,
    "DELETE",
  );
}

async function mutateTeam(path, method, body) {
  try {
    await requestJson(path, { method, ...(body ? { body } : {}) });
    const [members, invitations] = await Promise.all([
      requestJson(endpoints.teamMembers),
      requestJson(endpoints.teamInvitations),
    ]);
    renderTeamSecurity(
      members.members,
      invitations.invitations,
      state.teamRoles,
      state.teamAuthentication,
    );
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

function renderSimpleRows(body, items, cellsFor) {
  body.replaceChildren();
  for (const item of items) {
    const row = document.createElement("tr");
    for (const value of cellsFor(item)) {
      const cell = document.createElement("td");
      cell.textContent = detailValue(value);
      row.append(cell);
    }
    body.append(row);
  }
}

function openTeamInviteDialog() {
  elements.teamInviteForm.reset();
  elements.teamInviteError.hidden = true;
  elements.teamInviteDialog.showModal();
}

async function submitTeamInvitation(event) {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  setBusy(elements.submitTeamInvite, true, "Creating…");
  elements.teamInviteError.hidden = true;
  try {
    const payload = await requestJson(endpoints.teamInvitations, {
      method: "POST",
      body: {
        email: elements.teamInviteEmail.value.trim(),
        role: elements.teamInviteRole.value,
      },
    });
    renderTeamSecurity(
      state.teamMembers,
      payload.invitations,
      state.teamRoles,
      state.teamAuthentication,
    );
    elements.teamInviteDialog.close();
  } catch (error) {
    elements.teamInviteError.textContent = errorMessage(error);
    elements.teamInviteError.hidden = false;
  } finally {
    setBusy(elements.submitTeamInvite, false, "Create invitation");
  }
}

function renderIntegrations(integrations) {
  state.integrations = Array.isArray(integrations) ? integrations : [];
  elements.integrationGroups.replaceChildren();
  for (const group of ["payments", "tax", "accounting", "crm"]) {
    const section = document.createElement("section");
    section.className = "chart-card integration-group";
    const heading = document.createElement("div");
    heading.className = "chart-card-heading";
    const title = document.createElement("h3");
    title.textContent = humanize(group);
    heading.append(title);
    const grid = document.createElement("div");
    grid.className = "integration-grid";
    for (const integration of state.integrations.filter(
      (item) => item.integration_group === group,
    )) {
      const card = document.createElement("article");
      card.className = "integration-card";
      const name = document.createElement("strong");
      name.textContent = integration.name;
      const status = document.createElement("span");
      status.className = "role-pill";
      status.textContent = humanize(integration.status);
      const copy = document.createElement("p");
      copy.textContent = integration.external_actions_enabled
        ? "External actions enabled"
        : "Credentials and external actions disabled";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button";
      button.dataset.integrationCode = integration.provider_code;
      button.textContent =
        integration.status === "disabled" ? "Prepare configuration" : "Edit configuration";
      if (state.role !== "admin") button.disabled = true;
      card.append(name, status, copy, button);
      grid.append(card);
    }
    section.append(heading, grid);
    elements.integrationGroups.append(section);
  }
}

function handleIntegrationAction(event) {
  const button = event.target.closest("button[data-integration-code]");
  if (!button || state.role !== "admin") return;
  const integration = state.integrations.find(
    (item) => item.provider_code === button.dataset.integrationCode,
  );
  if (!integration) return;
  state.selectedIntegrationCode = integration.provider_code;
  elements.integrationDialogTitle.textContent = `Configure ${integration.name}`;
  elements.integrationDisplayName.value = integration.display_name ?? "";
  elements.integrationSettings.value = JSON.stringify(integration.settings ?? {}, null, 2);
  elements.integrationError.hidden = true;
  elements.integrationDialog.showModal();
}

async function submitIntegrationConfiguration(event) {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (!state.selectedIntegrationCode) return;
  setBusy(elements.submitIntegration, true, "Saving…");
  elements.integrationError.hidden = true;
  try {
    const settings = JSON.parse(elements.integrationSettings.value || "{}");
    await requestJson(
      `${endpoints.integrations}/${encodeURIComponent(state.selectedIntegrationCode)}`,
      {
        method: "PUT",
        body: { display_name: elements.integrationDisplayName.value.trim(), settings },
      },
    );
    const payload = await requestJson(endpoints.integrations);
    renderIntegrations(payload.integrations);
    elements.integrationDialog.close();
  } catch (error) {
    elements.integrationError.textContent = errorMessage(error);
    elements.integrationError.hidden = false;
  } finally {
    setBusy(elements.submitIntegration, false, "Save disabled configuration");
  }
}

function activitySummary(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return "No recorded changes";
  return logs
    .slice(0, 6)
    .map(
      (log) => `${humanize(log.event_type.replaceAll(".", "_"))} · ${formatDate(log.occurred_at)}`,
    )
    .join("\n");
}

function webhookLogSummary(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return "No deliveries";
  return logs
    .slice(0, 6)
    .map(
      (log) =>
        `${humanize(log.event_type)} · ${humanize(log.status)} · ${formatDate(log.updated_at)}`,
    )
    .join("\n");
}

function decorateEntityRows(tableBody, items, route) {
  const definition = entityDetailDefinitions[route];
  if (!definition) return;
  const rows = Array.from(tableBody.querySelectorAll("tr"));
  rows.forEach((row, index) => {
    const item = items[index];
    if (!item) return;
    const identifier = definition.id(item);
    if (identifier === null || identifier === undefined || identifier === "") return;
    const currentLabel = row.querySelector(".key-name");
    const link = document.createElement("a");
    link.className = currentLabel
      ? `${currentLabel.className} entity-link`
      : "key-name entity-link";
    link.href = routePath(state.organizationSlug, route, identifier);
    link.dataset.entityDetailRoute = route;
    link.dataset.entityDetailId = String(identifier);
    link.textContent = currentLabel?.textContent ?? definition.label(item);
    if (currentLabel) currentLabel.replaceWith(link);
    else row.cells[0]?.replaceChildren(link);
  });
}

function renderCustomerOverview(customer) {
  const subscriptions = state.subscriptions.filter(
    (subscription) => subscription.external_customer_id === customer.external_id,
  );
  const invoices = state.invoices.filter(
    (invoice) => invoice.external_customer_id === customer.external_id,
  );
  const heading = document.createElement("div");
  heading.className = "detail-panel-heading";
  const title = document.createElement("h2");
  title.textContent = "Billing overview";
  heading.append(title);

  const summaries = document.createElement("div");
  summaries.className = "detail-summary-grid";
  summaries.append(
    createDetailSummary("Invoices", String(invoices.length), "Retained billing documents"),
    createDetailSummary(
      "Subscriptions",
      String(subscriptions.length),
      "Active and historical subscriptions",
    ),
  );

  const subscriptionHeading = document.createElement("div");
  subscriptionHeading.className = "detail-panel-heading detail-panel-heading-spaced";
  const subscriptionTitle = document.createElement("h2");
  subscriptionTitle.textContent = "Subscriptions";
  subscriptionHeading.append(subscriptionTitle);
  elements.customerDetailTabPanel.append(heading, summaries, subscriptionHeading);
  renderCustomerCollection(subscriptions, "No subscriptions are assigned to this customer.");
}

function createDetailSummary(label, value, metadata) {
  const card = document.createElement("div");
  card.className = "detail-summary-card";
  const title = document.createElement("p");
  title.textContent = label;
  const amount = document.createElement("strong");
  amount.textContent = value;
  const detail = document.createElement("small");
  detail.textContent = metadata;
  card.append(title, amount, detail);
  return card;
}

function renderCustomerCollectionTab(titleText, items, emptyText) {
  const heading = document.createElement("div");
  heading.className = "detail-panel-heading";
  const title = document.createElement("h2");
  title.textContent = titleText;
  heading.append(title);
  elements.customerDetailTabPanel.append(heading);
  renderCustomerCollection(items, emptyText);
}

function renderCustomerCollection(items, emptyText) {
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "detail-empty";
    const copy = document.createElement("p");
    copy.textContent = emptyText;
    empty.append(copy);
    elements.customerDetailTabPanel.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "detail-record-list";
  for (const item of items) {
    const record = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = safeText(
      item.name,
      safeText(item.external_id, safeText(item.number, "Record")),
    );
    const status = document.createElement("span");
    status.className = "code-chip";
    status.textContent = safeText(item.status, "available");
    record.append(name, status);
    list.append(record);
  }
  elements.customerDetailTabPanel.append(list);
}

async function renderCustomerSettingsTab(customer) {
  elements.customerDetailTabPanel.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "detail-panel-heading";
  const title = document.createElement("h2");
  title.textContent = "Customer settings";
  heading.append(title);
  const settings = document.createElement("dl");
  settings.className = "detail-settings-list";
  for (const [label, value] of [
    ["Timezone", safeText(customer.timezone, "Organization default")],
    ["Currency", safeText(customer.currency, "Organization default")],
    ["Payment term", elements.customerDetailFieldTerm.textContent],
    ["Invoice grace period", `${nonNegativeNumber(customer.invoice_grace_period)} days`],
  ]) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    row.append(term, detail);
    settings.append(row);
  }
  elements.customerDetailTabPanel.append(heading, settings);

  const loading = document.createElement("div");
  loading.className = "table-loading compact";
  loading.textContent = "Loading document and tax settings…";
  elements.customerDetailTabPanel.append(loading);
  try {
    const [documentPayload, taxPayload] = await Promise.all([
      requestJson(customerDocumentSettingsEndpoint(customer.external_id)),
      requestJson(customerTaxesEndpoint(customer.external_id)),
    ]);
    if (state.detailTab !== "settings" || state.detailId !== customer.external_id) return;
    loading.remove();
    const form = document.createElement("form");
    form.className = "advanced-inline-form advanced-control-block";
    const title = document.createElement("h3");
    title.textContent = "Document settings";
    const copy = document.createElement("p");
    copy.textContent =
      "Override the billing entity locale and subscription issuing-date policy for this customer.";
    const grid = document.createElement("div");
    grid.className = "advanced-inline-grid";
    const locale = labeledSelect("Document locale", [
      ["", "Billing entity default"],
      ...["en", "fr", "de", "es", "it", "nb", "pt", "sv", "nl"].map((value) => [
        value,
        value.toUpperCase(),
      ]),
    ]);
    locale.select.value = documentPayload.document_settings?.document_locale ?? "";
    const adjustment = labeledSelect("Issuing-date adjustment", [
      ["", "Billing entity default"],
      ["keep_anchor", "Keep anchor"],
      ["align_with_finalization_date", "Align with finalization date"],
    ]);
    adjustment.select.value =
      documentPayload.document_settings?.subscription_invoice_issuing_date_adjustment ?? "";
    const anchor = labeledSelect("Issuing-date anchor", [
      ["", "Billing entity default"],
      ["current_period_end", "Current period end"],
      ["next_period_start", "Next period start"],
    ]);
    anchor.select.value =
      documentPayload.document_settings?.subscription_invoice_issuing_date_anchor ?? "";
    const finalizeZero = labeledSelect("Zero-amount invoices", [
      ["", "Billing entity default"],
      ["true", "Finalize"],
      ["false", "Keep as draft"],
    ]);
    const configuredFinalize = documentPayload.document_settings?.finalize_zero_amount_invoice;
    finalizeZero.select.value =
      configuredFinalize === null || configuredFinalize === undefined
        ? ""
        : configuredFinalize
          ? "true"
          : "false";
    const dunning = labeledSelect("Dunning campaign", [
      ["", "Organization default"],
      ["excluded", "Exclude from dunning"],
      ...state.dunningCampaigns.map((campaign) => [
        campaign.lago_id,
        safeText(campaign.name, campaign.code),
      ]),
    ]);
    dunning.select.value = customer.exclude_from_dunning_campaign
      ? "excluded"
      : (customer.applied_dunning_campaign_id ?? "");
    const taxLabel = document.createElement("label");
    taxLabel.textContent = "Applied taxes";
    const taxSelect = document.createElement("select");
    taxSelect.multiple = true;
    taxSelect.size = Math.min(5, Math.max(2, state.taxes.length));
    const selectedTaxCodes = new Set((taxPayload.taxes ?? []).map((tax) => tax.code));
    for (const tax of state.taxes) {
      const option = document.createElement("option");
      option.value = tax.code;
      option.textContent = `${safeText(tax.name, tax.code)} · ${Number(tax.rate) || 0}%`;
      option.selected = selectedTaxCodes.has(tax.code);
      taxSelect.append(option);
    }
    taxLabel.append(taxSelect);
    const sectionLabel = document.createElement("label");
    sectionLabel.textContent = "Invoice custom sections";
    const sectionSelect = document.createElement("select");
    sectionSelect.multiple = true;
    sectionSelect.size = Math.min(5, Math.max(2, state.sections.length));
    const selectedSectionCodes = new Set(
      (customer.selected_invoice_custom_sections ?? []).map((section) => section.code),
    );
    for (const section of state.sections) {
      const option = document.createElement("option");
      option.value = section.code;
      option.textContent = safeText(section.name, section.code);
      option.selected = selectedSectionCodes.has(section.code);
      sectionSelect.append(option);
    }
    sectionLabel.append(sectionSelect);
    grid.append(
      locale.label,
      adjustment.label,
      anchor.label,
      finalizeZero.label,
      dunning.label,
      taxLabel,
      sectionLabel,
    );
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const error = document.createElement("p");
    error.className = "form-error";
    error.hidden = true;
    if (state.role === "admin") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button danger";
      remove.textContent = "Delete customer";
      let armed = false;
      remove.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          remove.textContent = "Confirm delete customer";
          return;
        }
        setBusy(remove, true, "Deleting…");
        try {
          await requestJson(customerEndpoint(customer.external_id), { method: "DELETE" });
          await refreshCustomers();
          navigateToRoute("customers", { replace: true });
        } catch (requestError) {
          error.textContent = errorMessage(requestError);
          error.hidden = false;
          setBusy(remove, false, "Delete customer");
          armed = false;
        }
      });
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "primary-button";
      save.textContent = "Save customer settings";
      actions.append(remove, save);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setBusy(save, true, "Saving…");
        error.hidden = true;
        try {
          await requestJson(customerDocumentSettingsEndpoint(customer.external_id), {
            method: "PUT",
            body: {
              document_settings: {
                document_locale: locale.select.value || null,
                subscription_invoice_issuing_date_adjustment: adjustment.select.value || null,
                subscription_invoice_issuing_date_anchor: anchor.select.value || null,
                finalize_zero_amount_invoice:
                  finalizeZero.select.value === "" ? null : finalizeZero.select.value === "true",
              },
            },
          });
          await requestJson(customerEndpoint(customer.external_id), {
            method: "PUT",
            body: {
              customer: {
                applied_dunning_campaign_id:
                  dunning.select.value && dunning.select.value !== "excluded"
                    ? dunning.select.value
                    : null,
                exclude_from_dunning_campaign: dunning.select.value === "excluded",
                invoice_custom_section_codes: Array.from(sectionSelect.selectedOptions).map(
                  (option) => option.value,
                ),
              },
            },
          });
          const nextTaxes = new Set(
            Array.from(taxSelect.selectedOptions).map((option) => option.value),
          );
          await Promise.all([
            ...[...selectedTaxCodes]
              .filter((code) => !nextTaxes.has(code))
              .map((code) =>
                requestJson(
                  `${customerTaxesEndpoint(customer.external_id)}/${encodeURIComponent(code)}`,
                  {
                    method: "DELETE",
                  },
                ),
              ),
            ...[...nextTaxes]
              .filter((code) => !selectedTaxCodes.has(code))
              .map((code) =>
                requestJson(customerTaxesEndpoint(customer.external_id), {
                  method: "POST",
                  body: { applied_tax: { tax_code: code } },
                }),
              ),
          ]);
          await refreshCustomers();
          const refreshed = state.customers.find(
            (candidate) => candidate.external_id === customer.external_id,
          );
          if (refreshed) void renderCustomerSettingsTab(refreshed);
        } catch (requestError) {
          error.textContent = errorMessage(requestError);
          error.hidden = false;
        } finally {
          setBusy(save, false, "Save customer settings");
        }
      });
    } else {
      for (const control of grid.querySelectorAll("select")) control.disabled = true;
    }
    form.append(title, copy, grid, actions, error);
    elements.customerDetailTabPanel.append(form);
  } catch (error) {
    loading.className = "form-error inline-error";
    loading.textContent = errorMessage(error);
  }
}

function openCreateCustomerDialog() {
  state.customerFormMode = "create";
  state.selectedCustomerExternalId = null;
  elements.customerFormTitle.textContent = "Create customer";
  elements.customerFormCopy.textContent = "Create a tenant-scoped billing customer.";
  elements.submitCustomerForm.textContent = "Create customer";
  elements.customerForm.reset();
  elements.customerExternalId.disabled = false;
  elements.customerFormError.hidden = true;
  elements.customerFormDialog.showModal();
  elements.customerExternalId.focus();
}

function openEditCustomerDialog(customer) {
  state.customerFormMode = "edit";
  state.selectedCustomerExternalId = customer.external_id;
  elements.customerFormTitle.textContent = "Edit customer";
  elements.customerFormCopy.textContent = "Update the retained core billing fields.";
  elements.submitCustomerForm.textContent = "Save customer";
  elements.customerExternalId.value = formValue(customer.external_id);
  elements.customerExternalId.disabled = true;
  elements.customerName.value = formValue(customer.name);
  elements.customerEmail.value = formValue(customer.email);
  elements.customerCurrency.value = formValue(customer.currency);
  elements.customerTimezone.value = formValue(customer.timezone);
  elements.customerNetTerm.value = nullableNumberFormValue(customer.net_payment_term);
  elements.customerGracePeriod.value = nullableNumberFormValue(
    customer.billing_configuration?.invoice_grace_period,
  );
  elements.customerFormError.hidden = true;
  elements.customerFormDialog.showModal();
  elements.customerName.focus();
}

async function submitCustomerForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.customerFormDialog.close();
    return;
  }
  if (!elements.customerForm.reportValidity()) return;
  const isCreate = state.customerFormMode === "create";
  const externalId = isCreate
    ? elements.customerExternalId.value.trim()
    : state.selectedCustomerExternalId;
  setBusy(elements.submitCustomerForm, true, isCreate ? "Creating…" : "Saving…");
  elements.customerFormError.hidden = true;
  try {
    await requestJson(isCreate ? endpoints.customers : customerEndpoint(externalId), {
      method: isCreate ? "POST" : "PUT",
      body: {
        customer: {
          ...(isCreate ? { external_id: externalId } : {}),
          name: optionalFormValue(elements.customerName.value),
          email: optionalFormValue(elements.customerEmail.value),
          currency: optionalFormValue(elements.customerCurrency.value),
          timezone: optionalFormValue(elements.customerTimezone.value),
          net_payment_term: optionalNumberFormValue(elements.customerNetTerm.value),
          invoice_grace_period: optionalNumberFormValue(elements.customerGracePeriod.value),
        },
      },
    });
    elements.customerFormDialog.close();
    await refreshCustomers();
  } catch (error) {
    elements.customerFormError.textContent = errorMessage(error);
    elements.customerFormError.hidden = false;
  } finally {
    setBusy(elements.submitCustomerForm, false, isCreate ? "Create customer" : "Save customer");
  }
}

function renderCoupons(coupons) {
  state.coupons = Array.isArray(coupons) ? coupons : [];
  elements.couponsTableBody.replaceChildren();
  elements.couponsLoading.hidden = true;
  elements.couponsEmpty.hidden = state.coupons.length !== 0;
  elements.couponsTableShell.hidden = state.coupons.length === 0;
  for (const coupon of state.coupons) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "key-name";
    name.textContent = safeText(coupon.name, "Unnamed coupon");
    const description = document.createElement("span");
    description.className = "key-id";
    description.textContent = safeText(coupon.description, "No description");
    nameCell.append(name, description);
    const codeCell = document.createElement("td");
    const code = document.createElement("span");
    code.className = "code-chip";
    code.textContent = safeText(coupon.code, "—");
    codeCell.append(code);
    const discountCell = document.createElement("td");
    discountCell.textContent = couponDiscount(coupon);
    const frequencyCell = document.createElement("td");
    frequencyCell.textContent = couponFrequency(coupon);
    const expirationCell = document.createElement("td");
    expirationCell.textContent =
      coupon.expiration === "time_limit" ? formatDate(coupon.expiration_at) : "No expiration";
    row.append(nameCell, codeCell, discountCell, frequencyCell, expirationCell);
    elements.couponsTableBody.append(row);
  }
  decorateEntityRows(elements.couponsTableBody, state.coupons, "coupons");
}

function renderAppliedCoupons(appliedCoupons) {
  state.appliedCoupons = Array.isArray(appliedCoupons) ? appliedCoupons : [];
  elements.appliedCouponsTableBody.replaceChildren();
  elements.appliedCouponsLoading.hidden = true;
  elements.appliedCouponsEmpty.hidden = state.appliedCoupons.length !== 0;
  elements.appliedCouponsTableShell.hidden = state.appliedCoupons.length === 0;
  for (const applied of state.appliedCoupons) {
    const row = document.createElement("tr");
    const couponCell = document.createElement("td");
    couponCell.textContent = safeText(applied.coupon_code, "—");
    const customerCell = document.createElement("td");
    customerCell.textContent = safeText(applied.external_customer_id, "—");
    const discountCell = document.createElement("td");
    discountCell.textContent = couponDiscount(applied);
    const statusCell = document.createElement("td");
    statusCell.textContent = safeText(applied.status, "—");
    const dateCell = document.createElement("td");
    dateCell.textContent = formatDate(applied.created_at);
    const actionCell = document.createElement("td");
    actionCell.className = "actions-column";
    if (state.role === "admin" && applied.status === "active") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "row-action danger";
      button.dataset.appliedCouponId = applied.lago_id;
      button.textContent = "Terminate";
      actionCell.append(button);
    } else {
      actionCell.textContent = state.role === "admin" ? "Complete" : "Read only";
      actionCell.classList.add("muted");
    }
    row.append(couponCell, customerCell, discountCell, statusCell, dateCell, actionCell);
    elements.appliedCouponsTableBody.append(row);
  }
}

function openCreateCouponDialog() {
  elements.couponForm.reset();
  elements.couponReusable.checked = true;
  elements.couponFormError.hidden = true;
  elements.couponFormDialog.showModal();
  elements.couponName.focus();
}

async function submitCouponForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.couponFormDialog.close();
    return;
  }
  if (!elements.couponForm.reportValidity()) return;
  const couponType = elements.couponType.value;
  const frequency = elements.couponFrequency.value;
  const expiration = elements.couponExpiration.value;
  const coupon = {
    code: elements.couponCode.value.trim(),
    name: elements.couponName.value.trim(),
    description: optionalFormValue(elements.couponDescription.value),
    coupon_type: couponType,
    frequency,
    expiration,
    reusable: elements.couponReusable.checked,
    ...(couponType === "percentage"
      ? { percentage_rate: elements.couponPercentage.value }
      : {
          amount_cents: Number(elements.couponAmount.value),
          amount_currency: elements.couponCurrency.value.trim(),
        }),
    ...(frequency === "recurring"
      ? { frequency_duration: Number(elements.couponDuration.value) }
      : {}),
    ...(expiration === "time_limit"
      ? {
          expiration_at: elements.couponExpirationAt.value
            ? new Date(elements.couponExpirationAt.value).toISOString()
            : "",
        }
      : {}),
  };
  setBusy(elements.submitCouponForm, true, "Creating…");
  elements.couponFormError.hidden = true;
  try {
    await requestJson(endpoints.coupons, { method: "POST", body: { coupon } });
    elements.couponFormDialog.close();
    await refreshCoupons();
  } catch (error) {
    elements.couponFormError.textContent = errorMessage(error);
    elements.couponFormError.hidden = false;
  } finally {
    setBusy(elements.submitCouponForm, false, "Create coupon");
  }
}

function openApplyCouponDialog() {
  elements.applyCouponForm.reset();
  elements.applyCouponError.hidden = true;
  replaceSelectOptions(
    elements.applyCouponCustomer,
    state.customers,
    (customer) => customer.external_id,
    (customer) => `${safeText(customer.name, "Unnamed customer")} (${customer.external_id})`,
  );
  replaceSelectOptions(
    elements.applyCouponCode,
    state.coupons,
    (coupon) => coupon.code,
    (coupon) => `${safeText(coupon.name, "Unnamed coupon")} (${coupon.code})`,
  );
  if (state.customers.length === 0 || state.coupons.length === 0) {
    showPageError("Create at least one customer and one coupon before applying a coupon.");
    return;
  }
  elements.applyCouponDialog.showModal();
  elements.applyCouponCustomer.focus();
}

async function submitApplyCouponForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.applyCouponDialog.close();
    return;
  }
  if (!elements.applyCouponForm.reportValidity()) return;
  setBusy(elements.submitApplyCoupon, true, "Applying…");
  elements.applyCouponError.hidden = true;
  try {
    await requestJson(endpoints.appliedCoupons, {
      method: "POST",
      body: {
        applied_coupon: {
          external_customer_id: elements.applyCouponCustomer.value,
          coupon_code: elements.applyCouponCode.value,
        },
      },
    });
    elements.applyCouponDialog.close();
    await refreshAppliedCoupons();
  } catch (error) {
    elements.applyCouponError.textContent = errorMessage(error);
    elements.applyCouponError.hidden = false;
  } finally {
    setBusy(elements.submitApplyCoupon, false, "Apply coupon");
  }
}

function handleAppliedCouponAction(event) {
  const button = event.target.closest("button[data-applied-coupon-id]");
  if (!button || state.role !== "admin") return;
  const applied = state.appliedCoupons.find(
    (candidate) => candidate.lago_id === button.dataset.appliedCouponId,
  );
  if (!applied) return;
  state.confirmMode = "terminate-applied-coupon";
  state.selectedAppliedCouponId = applied.lago_id;
  elements.confirmError.hidden = true;
  elements.confirmTitle.textContent = "Terminate coupon application?";
  elements.confirmCopy.textContent = `Stop applying “${safeText(applied.coupon_code, "this coupon")}” to customer “${safeText(applied.external_customer_id, "unknown")}”?`;
  elements.confirmAction.textContent = "Terminate application";
  elements.confirmDialog.showModal();
}

function replaceSelectOptions(select, items, valueFor, labelFor) {
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement("option");
    option.value = valueFor(item);
    option.textContent = labelFor(item);
    select.append(option);
  }
}

function couponDiscount(coupon) {
  return coupon.percentage_rate !== null && coupon.percentage_rate !== undefined
    ? `${coupon.percentage_rate}%`
    : formatMoney(coupon.amount_cents, coupon.amount_currency);
}

function couponFrequency(coupon) {
  if (coupon.frequency !== "recurring") return safeText(coupon.frequency, "—");
  return `${nonNegativeNumber(coupon.frequency_duration)} cycles`;
}

function renderPlans(plans) {
  state.plans = Array.isArray(plans) ? plans : [];
  elements.plansTableBody.replaceChildren();
  elements.fixedChargesTableBody.replaceChildren();
  elements.plansLoading.hidden = true;
  elements.plansEmpty.hidden = state.plans.length !== 0;
  elements.plansTableShell.hidden = state.plans.length === 0;
  const fixedCharges = [];
  for (const plan of state.plans) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "key-name";
    name.textContent = safeText(plan.name, "Unnamed plan");
    const code = document.createElement("span");
    code.className = "key-id";
    code.textContent = safeText(plan.code, "—");
    nameCell.append(name, code);
    const interval = document.createElement("td");
    interval.textContent = safeText(plan.interval, "—");
    const amount = document.createElement("td");
    amount.textContent = formatMoney(plan.amount_cents, plan.amount_currency);
    const trial = document.createElement("td");
    trial.textContent = plan.trial_period === null ? "None" : `${plan.trial_period} days`;
    const fixedCount = document.createElement("td");
    fixedCount.textContent = countLabel(plan.fixed_charges, "charge", "charges");
    const actions = document.createElement("td");
    actions.className = "actions-column";
    if (state.role === "admin") {
      const group = document.createElement("div");
      group.className = "row-actions";
      group.append(
        planActionButton("Edit", "edit-plan", plan.code),
        planActionButton("Delete", "delete-plan", plan.code, true),
      );
      actions.append(group);
    } else actions.textContent = "Read only";
    row.append(nameCell, interval, amount, trial, fixedCount, actions);
    elements.plansTableBody.append(row);
    for (const fixed of Array.isArray(plan.fixed_charges) ? plan.fixed_charges : []) {
      fixedCharges.push({ ...fixed, plan_code: plan.code });
    }
  }
  elements.fixedChargesEmpty.hidden = fixedCharges.length !== 0;
  elements.fixedChargesTableShell.hidden = fixedCharges.length === 0;
  for (const fixed of fixedCharges)
    elements.fixedChargesTableBody.append(createFixedChargeRow(fixed));
  decorateEntityRows(elements.plansTableBody, state.plans, "plans");
}

function planActionButton(label, action, code, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "row-action danger" : "row-action";
  button.dataset.action = action;
  button.dataset.planCode = code;
  button.textContent = label;
  return button;
}

function createFixedChargeRow(fixed) {
  const row = document.createElement("tr");
  for (const value of [
    safeText(fixed.invoice_display_name, safeText(fixed.code, "—")),
    fixed.plan_code,
    fixed.add_on_code,
    fixed.charge_model,
    String(fixed.units),
  ]) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(cell);
  }
  const actions = document.createElement("td");
  actions.className = "actions-column";
  if (state.role === "admin") {
    const group = document.createElement("div");
    group.className = "row-actions";
    const edit = planActionButton("Edit", "edit-fixed-charge", fixed.plan_code);
    edit.dataset.fixedChargeCode = fixed.code;
    const remove = planActionButton("Delete", "delete-fixed-charge", fixed.plan_code, true);
    remove.dataset.fixedChargeCode = fixed.code;
    group.append(edit, remove);
    actions.append(group);
  } else actions.textContent = "Read only";
  row.append(actions);
  return row;
}

function handlePlanAction(event) {
  const button = event.target.closest("button[data-plan-code]");
  if (!button || state.role !== "admin") return;
  const plan = state.plans.find((item) => item.code === button.dataset.planCode);
  if (!plan) return;
  if (button.dataset.action === "edit-plan") openEditPlanDialog(plan);
  if (button.dataset.action === "delete-plan") openPlanDeletion(plan);
}

function handleFixedChargeAction(event) {
  const button = event.target.closest("button[data-fixed-charge-code]");
  if (!button || state.role !== "admin") return;
  const plan = state.plans.find((item) => item.code === button.dataset.planCode);
  const fixed = plan?.fixed_charges?.find((item) => item.code === button.dataset.fixedChargeCode);
  if (!plan || !fixed) return;
  if (button.dataset.action === "edit-fixed-charge") openEditFixedChargeDialog(plan, fixed);
  if (button.dataset.action === "delete-fixed-charge") openFixedChargeDeletion(plan, fixed);
}

async function openCreatePlanDialog() {
  state.planFormMode = "create";
  state.selectedPlanCode = null;
  elements.planForm.reset();
  await renderPlanEntitlementEditors([]);
  elements.planCode.disabled = false;
  elements.planFormTitle.textContent = "Create plan";
  elements.planFormCopy.textContent = "Create a core recurring plan.";
  elements.submitPlanForm.textContent = "Create plan";
  elements.planFormError.hidden = true;
  elements.planFormDialog.showModal();
  elements.planName.focus();
}

async function openEditPlanDialog(plan) {
  state.planFormMode = "edit";
  state.selectedPlanCode = plan.code;
  elements.planName.value = formValue(plan.name);
  elements.planCode.value = formValue(plan.code);
  elements.planCode.disabled = false;
  elements.planInterval.value = plan.interval;
  elements.planAmount.value = String(nonNegativeNumber(plan.amount_cents));
  elements.planCurrency.value = formValue(plan.amount_currency);
  elements.planTrial.value = nullableNumberFormValue(plan.trial_period);
  elements.planInvoiceName.value = formValue(plan.invoice_display_name);
  elements.planDescription.value = formValue(plan.description);
  elements.planPayAdvance.checked = plan.pay_in_advance === true;
  try {
    const payload = await requestJson(planEntitlementsEndpoint(plan.code));
    await renderPlanEntitlementEditors(payload.entitlements ?? []);
  } catch (error) {
    showPageError(errorMessage(error));
    return;
  }
  elements.planFormTitle.textContent = "Edit plan";
  elements.planFormCopy.textContent = "Attached plans may accept only safe scalar changes.";
  elements.submitPlanForm.textContent = "Save plan";
  elements.planFormError.hidden = true;
  elements.planFormDialog.showModal();
}

async function submitPlanForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.planFormDialog.close();
  if (!elements.planForm.reportValidity()) return;
  const create = state.planFormMode === "create";
  setBusy(elements.submitPlanForm, true, create ? "Creating…" : "Saving…");
  try {
    const planCode = elements.planCode.value.trim();
    await requestJson(create ? endpoints.plans : planEndpoint(state.selectedPlanCode), {
      method: create ? "POST" : "PUT",
      body: {
        plan: {
          code: planCode,
          name: elements.planName.value.trim(),
          invoice_display_name: optionalFormValue(elements.planInvoiceName.value),
          description: optionalFormValue(elements.planDescription.value),
          interval: elements.planInterval.value,
          amount_cents: Number(elements.planAmount.value),
          amount_currency: elements.planCurrency.value.trim(),
          trial_period: optionalNumberFormValue(elements.planTrial.value),
          pay_in_advance: elements.planPayAdvance.checked,
        },
      },
    });
    await requestJson(planEntitlementsEndpoint(planCode), {
      method: "PUT",
      body: { entitlements: collectPlanEntitlements() },
    });
    elements.planFormDialog.close();
    await refreshPlans();
  } catch (error) {
    elements.planFormError.textContent = errorMessage(error);
    elements.planFormError.hidden = false;
  } finally {
    setBusy(elements.submitPlanForm, false, create ? "Create plan" : "Save plan");
  }
}

async function renderPlanEntitlementEditors(existing) {
  const hydrated = await Promise.all(
    state.features.map(async (feature) => {
      if (Array.isArray(feature.privileges)) return feature;
      const payload = await requestJson(featureEndpoint(feature.lago_id));
      Object.assign(feature, payload.feature);
      return feature;
    }),
  );
  const current = new Map((existing ?? []).map((item) => [item.feature_code, item]));
  elements.planEntitlements.replaceChildren();
  elements.planEntitlementsEmpty.hidden = hydrated.length !== 0;
  for (const feature of hydrated) {
    const entitlement = current.get(feature.code);
    const fieldset = document.createElement("fieldset");
    fieldset.className = "plan-entitlement-row";
    fieldset.dataset.featureCode = feature.code;
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "checkbox-field";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(entitlement);
    toggle.dataset.entitlementToggle = "1";
    const title = document.createElement("span");
    title.textContent = `${safeText(feature.name, feature.code)} (${feature.code})`;
    toggleLabel.append(toggle, title);
    fieldset.append(toggleLabel);
    const existingValues = new Map(
      (entitlement?.privileges ?? []).map((privilege) => [
        privilege.privilege_code,
        privilege.value,
      ]),
    );
    const values = document.createElement("div");
    values.className = "entitlement-privilege-values";
    values.hidden = !toggle.checked;
    for (const privilege of feature.privileges ?? []) {
      values.append(createEntitlementValueEditor(privilege, existingValues.get(privilege.code)));
    }
    toggle.addEventListener("change", () => {
      values.hidden = !toggle.checked;
    });
    fieldset.append(values);
    elements.planEntitlements.append(fieldset);
  }
}

function createEntitlementValueEditor(privilege, existingValue) {
  const label = document.createElement("label");
  label.textContent = `${safeText(privilege.name, privilege.code)} (${privilege.code})`;
  let input;
  if (privilege.value_type === "boolean") {
    input = document.createElement("select");
    for (const value of ["true", "false"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = humanize(value);
      input.append(option);
    }
    input.value = String(existingValue ?? false);
  } else if (privilege.value_type === "select") {
    input = document.createElement("select");
    for (const value of privilege.config?.select_options ?? []) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      input.append(option);
    }
    if (existingValue !== null && existingValue !== undefined) input.value = String(existingValue);
  } else {
    input = document.createElement("input");
    input.type = privilege.value_type === "integer" ? "number" : "text";
    if (input.type === "number") input.step = "1";
    input.value =
      existingValue === null || existingValue === undefined ? "" : String(existingValue);
  }
  input.dataset.entitlementPrivilegeCode = privilege.code;
  input.dataset.entitlementValueType = privilege.value_type;
  input.required = true;
  label.append(input);
  return label;
}

function collectPlanEntitlements() {
  return Array.from(elements.planEntitlements.querySelectorAll(".plan-entitlement-row"))
    .filter((row) => row.querySelector("[data-entitlement-toggle]").checked)
    .map((row) => ({
      feature_code: row.dataset.featureCode,
      privileges: Array.from(row.querySelectorAll("[data-entitlement-privilege-code]")).map(
        (input) => ({
          privilege_code: input.dataset.entitlementPrivilegeCode,
          value:
            input.dataset.entitlementValueType === "boolean"
              ? input.value === "true"
              : input.dataset.entitlementValueType === "integer"
                ? Number(input.value)
                : input.value,
        }),
      ),
    }));
}

function openCreateFixedChargeDialog() {
  if (state.plans.length === 0 || state.addOns.length === 0)
    return showPageError("Create a plan and add-on before adding a fixed charge.");
  state.fixedChargeFormMode = "create";
  state.selectedFixedChargeCode = null;
  elements.fixedChargeForm.reset();
  elements.fixedChargeProperties.value = '{"amount":"0"}';
  replaceSelectOptions(
    elements.fixedChargePlan,
    state.plans,
    (item) => item.code,
    (item) => `${item.name} (${item.code})`,
  );
  replaceSelectOptions(
    elements.fixedChargeAddOn,
    state.addOns,
    (item) => item.lago_id,
    (item) => `${item.name} (${item.code})`,
  );
  for (const control of [
    elements.fixedChargePlan,
    elements.fixedChargeAddOn,
    elements.fixedChargeCode,
    elements.fixedChargeModel,
    elements.fixedChargePayAdvance,
    elements.fixedChargeProrated,
  ])
    control.disabled = false;
  elements.fixedChargeFormTitle.textContent = "Add fixed charge";
  elements.submitFixedChargeForm.textContent = "Add fixed charge";
  elements.fixedChargeFormError.hidden = true;
  elements.fixedChargeFormDialog.showModal();
}

function openEditFixedChargeDialog(plan, fixed) {
  state.fixedChargeFormMode = "edit";
  state.selectedPlanCode = plan.code;
  state.selectedFixedChargeCode = fixed.code;
  replaceSelectOptions(
    elements.fixedChargePlan,
    [plan],
    (item) => item.code,
    (item) => item.name,
  );
  replaceSelectOptions(
    elements.fixedChargeAddOn,
    [{ lago_id: fixed.lago_add_on_id, name: fixed.add_on_code }],
    (item) => item.lago_id,
    (item) => item.name,
  );
  elements.fixedChargeCode.value = fixed.code;
  elements.fixedChargeModel.value = fixed.charge_model;
  elements.fixedChargeUnits.value = fixed.units;
  elements.fixedChargeInvoiceName.value = formValue(fixed.invoice_display_name);
  elements.fixedChargeProperties.value = JSON.stringify(fixed.properties ?? {}, null, 2);
  elements.fixedChargePayAdvance.checked = fixed.pay_in_advance === true;
  elements.fixedChargeProrated.checked = fixed.prorated === true;
  for (const control of [
    elements.fixedChargePlan,
    elements.fixedChargeAddOn,
    elements.fixedChargeModel,
    elements.fixedChargePayAdvance,
    elements.fixedChargeProrated,
  ])
    control.disabled = true;
  elements.fixedChargeFormTitle.textContent = "Edit fixed charge";
  elements.submitFixedChargeForm.textContent = "Save fixed charge";
  elements.fixedChargeFormError.hidden = true;
  elements.fixedChargeFormDialog.showModal();
}

async function submitFixedChargeForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.fixedChargeFormDialog.close();
  if (!elements.fixedChargeForm.reportValidity()) return;
  const create = state.fixedChargeFormMode === "create";
  let properties;
  try {
    properties = JSON.parse(elements.fixedChargeProperties.value);
  } catch {
    elements.fixedChargeFormError.textContent = "Rating properties must be valid JSON.";
    elements.fixedChargeFormError.hidden = false;
    return;
  }
  const planCode = create ? elements.fixedChargePlan.value : state.selectedPlanCode;
  const path = create
    ? fixedChargesEndpoint(planCode)
    : fixedChargeEndpoint(planCode, state.selectedFixedChargeCode);
  setBusy(elements.submitFixedChargeForm, true, create ? "Adding…" : "Saving…");
  try {
    await requestJson(path, {
      method: create ? "POST" : "PUT",
      body: {
        fixed_charge: {
          ...(create
            ? {
                add_on_id: elements.fixedChargeAddOn.value,
                charge_model: elements.fixedChargeModel.value,
                pay_in_advance: elements.fixedChargePayAdvance.checked,
                prorated: elements.fixedChargeProrated.checked,
              }
            : {}),
          code: elements.fixedChargeCode.value.trim(),
          invoice_display_name: optionalFormValue(elements.fixedChargeInvoiceName.value),
          properties,
          units: elements.fixedChargeUnits.value,
          apply_units_immediately: elements.fixedChargeApplyNow.checked,
        },
      },
    });
    elements.fixedChargeFormDialog.close();
    await refreshPlans();
  } catch (error) {
    elements.fixedChargeFormError.textContent = errorMessage(error);
    elements.fixedChargeFormError.hidden = false;
  } finally {
    setBusy(
      elements.submitFixedChargeForm,
      false,
      create ? "Add fixed charge" : "Save fixed charge",
    );
  }
}

function openPlanDeletion(plan) {
  state.confirmMode = "delete-plan";
  state.selectedPlanCode = plan.code;
  elements.confirmTitle.textContent = "Delete plan?";
  elements.confirmCopy.textContent =
    "Unused plans retire immediately. Plans with subscriptions enter the durable asynchronous retirement workflow.";
  elements.confirmAction.textContent = "Delete plan";
  elements.confirmError.hidden = true;
  elements.confirmDialog.showModal();
}

function openFixedChargeDeletion(plan, fixed) {
  state.confirmMode = "delete-fixed-charge";
  state.selectedPlanCode = plan.code;
  state.selectedFixedChargeCode = fixed.code;
  elements.confirmTitle.textContent = "Delete fixed charge?";
  elements.confirmCopy.textContent = `Remove “${fixed.code}” from plan “${plan.code}”?`;
  elements.confirmAction.textContent = "Delete fixed charge";
  elements.confirmError.hidden = true;
  elements.confirmDialog.showModal();
}

function renderSubscriptions(subscriptions) {
  state.subscriptions = Array.isArray(subscriptions) ? subscriptions : [];
  elements.subscriptionsTableBody.replaceChildren();
  elements.subscriptionsLoading.hidden = true;
  elements.subscriptionsEmpty.hidden = state.subscriptions.length !== 0;
  elements.subscriptionsTableShell.hidden = state.subscriptions.length === 0;
  for (const subscription of state.subscriptions) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const name = document.createElement("span");
    name.className = "key-name";
    name.textContent = safeText(subscription.name, "Unnamed subscription");
    const externalId = document.createElement("span");
    externalId.className = "key-id";
    externalId.textContent = safeText(subscription.external_id, "—");
    identity.append(name, externalId);
    const customer = document.createElement("td");
    customer.textContent = safeText(subscription.external_customer_id, "—");
    const plan = document.createElement("td");
    plan.textContent = safeText(subscription.plan_code, "—");
    const status = document.createElement("td");
    status.textContent = safeText(subscription.status, "—");
    const period = document.createElement("td");
    period.textContent = subscription.current_period_start
      ? `${formatDate(subscription.current_period_start)} – ${formatDate(subscription.current_period_end)}`
      : subscription.subscription_at
        ? `Starts ${formatDate(subscription.subscription_at)}`
        : "—";
    const actions = document.createElement("td");
    actions.className = "actions-column";
    if (state.role === "admin" && ["active", "past_due", "pending"].includes(subscription.status)) {
      const group = document.createElement("div");
      group.className = "row-actions";
      group.append(
        subscriptionActionButton("Edit", "edit-subscription", subscription.external_id),
        subscriptionActionButton(
          subscription.status === "pending" ? "Cancel" : "Terminate",
          "terminate-subscription",
          subscription.external_id,
          true,
        ),
      );
      actions.append(group);
    } else {
      actions.textContent = state.role === "admin" ? "Complete" : "Read only";
      actions.classList.add("muted");
    }
    row.append(identity, customer, plan, status, period, actions);
    elements.subscriptionsTableBody.append(row);
  }
  decorateEntityRows(elements.subscriptionsTableBody, state.subscriptions, "subscriptions");
}

function subscriptionActionButton(label, action, externalId, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "row-action danger" : "row-action";
  button.dataset.action = action;
  button.dataset.subscriptionExternalId = externalId;
  button.textContent = label;
  return button;
}

function handleSubscriptionAction(event) {
  const button = event.target.closest("button[data-subscription-external-id]");
  if (!button || state.role !== "admin") return;
  const subscription = state.subscriptions.find(
    (item) => item.external_id === button.dataset.subscriptionExternalId,
  );
  if (!subscription) return;
  if (button.dataset.action === "edit-subscription") openEditSubscriptionDialog(subscription);
  if (button.dataset.action === "terminate-subscription") openSubscriptionTermination(subscription);
}

function populateSubscriptionSelectors(customerId, planCode) {
  replaceSelectOptions(
    elements.subscriptionCustomer,
    state.customers,
    (item) => item.external_id,
    (item) => `${safeText(item.name, "Unnamed customer")} (${item.external_id})`,
  );
  replaceSelectOptions(
    elements.subscriptionPlan,
    state.plans,
    (item) => item.code,
    (item) => `${safeText(item.name, "Unnamed plan")} (${item.code})`,
  );
  if (customerId) elements.subscriptionCustomer.value = customerId;
  if (planCode) elements.subscriptionPlan.value = planCode;
}

function openCreateSubscriptionDialog() {
  if (state.customers.length === 0 || state.plans.length === 0) {
    showPageError("Create at least one customer and one plan before creating a subscription.");
    return;
  }
  state.subscriptionFormMode = "create";
  state.selectedSubscriptionExternalId = null;
  elements.subscriptionForm.reset();
  populateSubscriptionSelectors();
  elements.subscriptionExternalId.disabled = false;
  elements.subscriptionCustomer.disabled = false;
  elements.subscriptionBillingTime.disabled = false;
  elements.subscriptionFormTitle.textContent = "Create subscription";
  elements.subscriptionFormCopy.textContent = "Create a customer subscription.";
  elements.submitSubscriptionForm.textContent = "Create subscription";
  elements.subscriptionFormError.hidden = true;
  elements.subscriptionFormDialog.showModal();
  elements.subscriptionExternalId.focus();
}

function openEditSubscriptionDialog(subscription) {
  state.subscriptionFormMode = "edit";
  state.selectedSubscriptionExternalId = subscription.external_id;
  populateSubscriptionSelectors(subscription.external_customer_id, subscription.plan_code);
  elements.subscriptionExternalId.value = subscription.external_id;
  elements.subscriptionExternalId.disabled = true;
  elements.subscriptionCustomer.disabled = true;
  elements.subscriptionName.value = formValue(subscription.name);
  elements.subscriptionAt.value = datetimeLocalValue(subscription.subscription_at);
  elements.subscriptionEndingAt.value = datetimeLocalValue(subscription.ending_at);
  elements.subscriptionBillingTime.value = subscription.billing_time ?? "anniversary";
  elements.subscriptionBillingTime.disabled = true;
  elements.subscriptionTerminationInvoice.value = subscription.on_termination_invoice ?? "generate";
  elements.subscriptionTerminationCredit.value =
    subscription.on_termination_credit_note ?? "credit";
  elements.subscriptionFormTitle.textContent = "Edit subscription";
  elements.subscriptionFormCopy.textContent = "Update scheduling or select a different plan.";
  elements.submitSubscriptionForm.textContent = "Save subscription";
  elements.subscriptionFormError.hidden = true;
  elements.subscriptionFormDialog.showModal();
}

async function submitSubscriptionForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.subscriptionFormDialog.close();
  if (!elements.subscriptionForm.reportValidity()) return;
  const create = state.subscriptionFormMode === "create";
  const existing = state.subscriptions.find(
    (item) => item.external_id === state.selectedSubscriptionExternalId,
  );
  const planChange = !create && existing?.plan_code !== elements.subscriptionPlan.value;
  const useCreate = create || planChange;
  const externalId = create
    ? elements.subscriptionExternalId.value.trim()
    : state.selectedSubscriptionExternalId;
  const shared = {
    name: optionalFormValue(elements.subscriptionName.value),
    ending_at: isoFormValue(elements.subscriptionEndingAt.value),
    on_termination_invoice: elements.subscriptionTerminationInvoice.value,
    on_termination_credit_note: elements.subscriptionTerminationCredit.value,
  };
  const body = useCreate
    ? {
        external_customer_id: elements.subscriptionCustomer.value,
        external_id: externalId,
        plan_code: elements.subscriptionPlan.value,
        billing_time: elements.subscriptionBillingTime.value,
        subscription_at: isoFormValue(elements.subscriptionAt.value),
        ...shared,
      }
    : { subscription_at: isoFormValue(elements.subscriptionAt.value), ...shared };
  setBusy(elements.submitSubscriptionForm, true, useCreate ? "Applying…" : "Saving…");
  elements.subscriptionFormError.hidden = true;
  try {
    await requestJson(useCreate ? endpoints.subscriptions : subscriptionEndpoint(externalId), {
      method: useCreate ? "POST" : "PUT",
      body: { subscription: body },
    });
    elements.subscriptionFormDialog.close();
    await refreshSubscriptions();
  } catch (error) {
    elements.subscriptionFormError.textContent = errorMessage(error);
    elements.subscriptionFormError.hidden = false;
  } finally {
    setBusy(
      elements.submitSubscriptionForm,
      false,
      create ? "Create subscription" : "Save subscription",
    );
  }
}

function openSubscriptionTermination(subscription) {
  state.selectedSubscriptionExternalId = subscription.external_id;
  elements.terminateSubscriptionCopy.textContent =
    subscription.status === "pending"
      ? `Cancel pending subscription “${subscription.external_id}”? No invoice will be created.`
      : `Terminate “${subscription.external_id}”? The selected billing actions are persisted with the transition.`;
  elements.terminateSubscriptionInvoice.value = subscription.on_termination_invoice ?? "generate";
  elements.terminateSubscriptionCredit.value = subscription.on_termination_credit_note ?? "credit";
  elements.terminateSubscriptionInvoice.disabled = subscription.status === "pending";
  elements.terminateSubscriptionCredit.disabled = subscription.status === "pending";
  elements.submitTerminateSubscription.textContent =
    subscription.status === "pending" ? "Cancel subscription" : "Terminate subscription";
  elements.terminateSubscriptionError.hidden = true;
  elements.terminateSubscriptionDialog.showModal();
}

async function submitTerminateSubscription(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.terminateSubscriptionDialog.close();
  const subscription = state.subscriptions.find(
    (item) => item.external_id === state.selectedSubscriptionExternalId,
  );
  if (!subscription) return elements.terminateSubscriptionDialog.close();
  setBusy(
    elements.submitTerminateSubscription,
    true,
    subscription.status === "pending" ? "Canceling…" : "Terminating…",
  );
  try {
    const query =
      subscription.status === "pending"
        ? ""
        : `?on_termination_invoice=${encodeURIComponent(elements.terminateSubscriptionInvoice.value)}&on_termination_credit_note=${encodeURIComponent(elements.terminateSubscriptionCredit.value)}`;
    await requestJson(`${subscriptionEndpoint(subscription.external_id)}${query}`, {
      method: "DELETE",
    });
    elements.terminateSubscriptionDialog.close();
    await refreshSubscriptions();
  } catch (error) {
    elements.terminateSubscriptionError.textContent = errorMessage(error);
    elements.terminateSubscriptionError.hidden = false;
  } finally {
    setBusy(
      elements.submitTerminateSubscription,
      false,
      subscription.status === "pending" ? "Cancel subscription" : "Terminate subscription",
    );
  }
}

function renderInvoices(invoices) {
  state.invoices = Array.isArray(invoices) ? invoices : [];
  elements.invoicesTableBody.replaceChildren();
  elements.invoicesLoading.hidden = true;
  elements.invoicesEmpty.hidden = state.invoices.length !== 0;
  elements.invoicesTableShell.hidden = state.invoices.length === 0;
  for (const invoice of state.invoices) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const number = document.createElement("span");
    number.className = "key-name";
    number.textContent = safeText(invoice.number, "Unnumbered invoice");
    const id = document.createElement("span");
    id.className = "key-id";
    id.textContent = safeText(invoice.lago_id, "—");
    identity.append(number, id);
    const values = [
      invoice.external_customer_id,
      invoice.invoice_type,
      invoice.status,
      invoice.payment_status,
      formatMoney(invoice.total_amount_cents, invoice.currency),
    ];
    row.append(identity);
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = safeText(value, "—");
      row.append(cell);
    }
    const actions = document.createElement("td");
    actions.className = "actions-column";
    if (state.role === "admin") {
      const group = document.createElement("div");
      group.className = "row-actions";
      if (invoice.status === "draft") {
        group.append(
          invoiceActionButton("Refresh", "refresh-invoice", invoice.lago_id),
          invoiceActionButton("Finalize", "finalize-invoice", invoice.lago_id),
        );
      } else if (invoice.status === "finalized" && invoice.payment_status !== "succeeded") {
        group.append(invoiceActionButton("Void", "void-invoice", invoice.lago_id, true));
      }
      if (group.childNodes.length > 0) actions.append(group);
      else actions.textContent = "No action";
    } else actions.textContent = "Read only";
    row.append(actions);
    elements.invoicesTableBody.append(row);
  }
  decorateEntityRows(elements.invoicesTableBody, state.invoices, "invoices");
}

function invoiceActionButton(label, action, invoiceId, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "row-action danger" : "row-action";
  button.dataset.action = action;
  button.dataset.invoiceId = invoiceId;
  button.textContent = label;
  return button;
}

async function handleInvoiceAction(event) {
  const button = event.target.closest("button[data-invoice-id]");
  if (!button || state.role !== "admin") return;
  const invoice = state.invoices.find((item) => item.lago_id === button.dataset.invoiceId);
  if (!invoice) return;
  if (button.dataset.action === "refresh-invoice") {
    button.disabled = true;
    try {
      await requestJson(`${invoiceEndpoint(invoice.lago_id)}/refresh`, { method: "PUT" });
      await refreshInvoices();
    } catch (error) {
      showPageError(errorMessage(error));
    } finally {
      button.disabled = false;
    }
    return;
  }
  state.selectedInvoiceId = invoice.lago_id;
  state.confirmMode = button.dataset.action;
  elements.confirmError.hidden = true;
  if (button.dataset.action === "finalize-invoice") {
    elements.confirmTitle.textContent = "Finalize invoice?";
    elements.confirmCopy.textContent =
      "Finalization freezes the refreshed billing snapshot and payment due date.";
    elements.confirmAction.textContent = "Finalize invoice";
  } else {
    elements.confirmTitle.textContent = "Void invoice?";
    elements.confirmCopy.textContent =
      "Voiding reverses retained wallet, coupon, and credit-note allocations. Paid invoices remain protected.";
    elements.confirmAction.textContent = "Void invoice";
  }
  elements.confirmDialog.showModal();
}

function openCreateInvoiceDialog() {
  if (state.customers.length === 0 || state.addOns.length === 0) {
    showPageError("Create a customer and add-on before creating a one-off invoice.");
    return;
  }
  elements.invoiceForm.reset();
  replaceSelectOptions(
    elements.invoiceCustomer,
    state.customers,
    (item) => item.external_id,
    (item) => `${safeText(item.name, "Unnamed customer")} (${item.external_id})`,
  );
  elements.invoiceCurrency.value = state.customers[0]?.currency ?? "";
  elements.invoiceFees.value = JSON.stringify(
    [{ add_on_code: state.addOns[0]?.code ?? "", units: 1 }],
    null,
    2,
  );
  elements.invoiceFormError.hidden = true;
  elements.invoiceFormDialog.showModal();
}

async function submitInvoiceForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.invoiceFormDialog.close();
  if (!elements.invoiceForm.reportValidity()) return;
  let fees;
  try {
    fees = JSON.parse(elements.invoiceFees.value);
    if (!Array.isArray(fees) || fees.length === 0) throw new Error("invalid_fees");
  } catch {
    elements.invoiceFormError.textContent = "Fees must be a non-empty JSON array.";
    elements.invoiceFormError.hidden = false;
    return;
  }
  setBusy(elements.submitInvoiceForm, true, "Creating…");
  try {
    await requestJson(endpoints.invoices, {
      method: "POST",
      body: {
        invoice: {
          external_customer_id: elements.invoiceCustomer.value,
          currency: elements.invoiceCurrency.value.trim(),
          skip_psp: true,
          fees,
        },
      },
    });
    elements.invoiceFormDialog.close();
    await refreshInvoices();
  } catch (error) {
    elements.invoiceFormError.textContent = errorMessage(error);
    elements.invoiceFormError.hidden = false;
  } finally {
    setBusy(elements.submitInvoiceForm, false, "Create finalized invoice");
  }
}

function renderWallets(wallets) {
  state.wallets = Array.isArray(wallets) ? wallets : [];
  elements.walletsTableBody.replaceChildren();
  elements.walletsLoading.hidden = true;
  elements.walletsEmpty.hidden = state.wallets.length !== 0;
  elements.walletsTableShell.hidden = state.wallets.length === 0;
  for (const wallet of state.wallets) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const name = document.createElement("span");
    name.className = "key-name";
    name.textContent = safeText(wallet.name, safeText(wallet.code, "Unnamed wallet"));
    const code = document.createElement("span");
    code.className = "key-id";
    code.textContent = safeText(wallet.code, "—");
    identity.append(name, code);
    row.append(identity);
    const values = [
      wallet.external_customer_id,
      `${safeText(String(wallet.credits_balance ?? "0"), "0")} credits (${formatMoney(wallet.balance_cents, wallet.currency)})`,
      safeText(String(wallet.rate_amount ?? "—"), "—"),
      wallet.status,
      wallet.expiration_at ? formatDate(wallet.expiration_at) : "Never",
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = safeText(value, "—");
      row.append(cell);
    }
    const actions = document.createElement("td");
    actions.className = "actions-column";
    if (state.role === "admin" && wallet.status === "active") {
      const group = document.createElement("div");
      group.className = "row-actions";
      group.append(
        walletActionButton("Grant credits", "top-up-wallet", wallet.lago_id),
        walletActionButton("Terminate", "terminate-wallet", wallet.lago_id, true),
      );
      actions.append(group);
    } else actions.textContent = state.role === "admin" ? "No action" : "Read only";
    row.append(actions);
    elements.walletsTableBody.append(row);
  }
  decorateEntityRows(elements.walletsTableBody, state.wallets, "wallets");
}

function walletActionButton(label, action, walletId, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "row-action danger" : "row-action";
  button.dataset.action = action;
  button.dataset.walletId = walletId;
  button.textContent = label;
  return button;
}

function handleWalletAction(event) {
  const button = event.target.closest("button[data-wallet-id]");
  if (!button || state.role !== "admin") return;
  const wallet = state.wallets.find((item) => item.lago_id === button.dataset.walletId);
  if (!wallet) return;
  state.selectedWalletId = wallet.lago_id;
  if (button.dataset.action === "top-up-wallet") {
    elements.walletTopUpForm.reset();
    elements.walletTopUpError.hidden = true;
    elements.walletTopUpDialog.showModal();
    return;
  }
  state.confirmMode = "terminate-wallet";
  elements.confirmTitle.textContent = "Terminate wallet?";
  elements.confirmCopy.textContent =
    "The wallet will stop applying to new invoices. Its ledger history remains auditable.";
  elements.confirmAction.textContent = "Terminate wallet";
  elements.confirmError.hidden = true;
  elements.confirmDialog.showModal();
}

function openCreateWalletDialog() {
  if (state.customers.length === 0) {
    showPageError("Create a customer before creating a granted-credit wallet.");
    return;
  }
  elements.walletForm.reset();
  replaceSelectOptions(
    elements.walletCustomer,
    state.customers,
    (item) => item.external_id,
    (item) => `${safeText(item.name, "Unnamed customer")} (${item.external_id})`,
  );
  elements.walletCurrency.value = state.customers[0]?.currency ?? "";
  elements.walletRate.value = "1";
  elements.walletCredits.value = "0";
  elements.walletPriority.value = "50";
  elements.walletFormError.hidden = true;
  elements.walletFormDialog.showModal();
}

async function submitWalletForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.walletFormDialog.close();
  if (!elements.walletForm.reportValidity()) return;
  setBusy(elements.submitWalletForm, true, "Creating…");
  try {
    await requestJson(endpoints.wallets, {
      method: "POST",
      body: {
        wallet: {
          external_customer_id: elements.walletCustomer.value,
          name: elements.walletName.value.trim(),
          code: elements.walletCode.value.trim(),
          currency: elements.walletCurrency.value.trim(),
          rate_amount: elements.walletRate.value,
          granted_credits: elements.walletCredits.value,
          priority: Number(elements.walletPriority.value),
          expiration_at: isoFormValue(elements.walletExpiration.value),
        },
      },
    });
    elements.walletFormDialog.close();
    await refreshWallets();
  } catch (error) {
    elements.walletFormError.textContent = errorMessage(error);
    elements.walletFormError.hidden = false;
  } finally {
    setBusy(elements.submitWalletForm, false, "Create wallet");
  }
}

async function submitWalletTopUp(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.walletTopUpDialog.close();
  if (!state.selectedWalletId || !elements.walletTopUpForm.reportValidity()) return;
  setBusy(elements.submitWalletTopUp, true, "Granting…");
  try {
    await requestJson(endpoints.walletTransactions, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        wallet_transaction: {
          wallet_id: state.selectedWalletId,
          granted_credits: elements.walletTopUpCredits.value,
          name: optionalFormValue(elements.walletTopUpName.value),
        },
      },
    });
    elements.walletTopUpDialog.close();
    await refreshWallets();
  } catch (error) {
    elements.walletTopUpError.textContent = errorMessage(error);
    elements.walletTopUpError.hidden = false;
  } finally {
    setBusy(elements.submitWalletTopUp, false, "Grant credits");
  }
}

function renderCreditNotes(notes) {
  state.creditNotes = Array.isArray(notes) ? notes : [];
  elements.creditNotesTableBody.replaceChildren();
  elements.creditNotesLoading.hidden = true;
  elements.creditNotesEmpty.hidden = state.creditNotes.length !== 0;
  elements.creditNotesTableShell.hidden = state.creditNotes.length === 0;
  for (const note of state.creditNotes) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const number = document.createElement("span");
    number.className = "key-name";
    number.textContent = safeText(note.number, "Unnumbered credit note");
    const id = document.createElement("span");
    id.className = "key-id";
    id.textContent = safeText(note.lago_id, "—");
    identity.append(number, id);
    row.append(identity);
    const values = [
      note.invoice_number,
      note.external_customer_id,
      note.reason,
      `${safeText(note.status, "—")} / ${safeText(note.credit_status, "—")}`,
      formatMoney(note.balance_amount_cents, note.currency),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = safeText(value, "—");
      row.append(cell);
    }
    const actions = document.createElement("td");
    actions.className = "actions-column";
    if (state.role === "admin" && note.credit_status === "available") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "row-action danger";
      button.dataset.creditNoteId = note.lago_id;
      button.textContent = "Void";
      actions.append(button);
    } else actions.textContent = state.role === "admin" ? "No action" : "Read only";
    row.append(actions);
    elements.creditNotesTableBody.append(row);
  }
  decorateEntityRows(elements.creditNotesTableBody, state.creditNotes, "credit-notes");
}

function handleCreditNoteAction(event) {
  const button = event.target.closest("button[data-credit-note-id]");
  if (!button || state.role !== "admin") return;
  state.selectedCreditNoteId = button.dataset.creditNoteId;
  state.confirmMode = "void-credit-note";
  elements.confirmTitle.textContent = "Void credit note?";
  elements.confirmCopy.textContent =
    "Only a fully unconsumed internal credit can be voided. Ledger history remains auditable.";
  elements.confirmAction.textContent = "Void credit note";
  elements.confirmError.hidden = true;
  elements.confirmDialog.showModal();
}

function renderPayments(payments) {
  state.payments = Array.isArray(payments) ? payments : [];
  elements.paymentsTableBody.replaceChildren();
  elements.paymentsLoading.hidden = true;
  elements.paymentsEmpty.hidden = state.payments.length !== 0;
  elements.paymentsTableShell.hidden = state.payments.length === 0;
  for (const payment of state.payments) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const id = document.createElement("span");
    id.className = "key-name";
    id.textContent = safeText(payment.lago_id, "Unknown payment");
    const type = document.createElement("span");
    type.className = "key-id";
    type.textContent = safeText(payment.type, "—");
    identity.append(id, type);
    row.append(identity);
    const values = [
      payment.external_customer_id,
      Array.isArray(payment.invoice_numbers) && payment.invoice_numbers.length > 0
        ? payment.invoice_numbers.join(", ")
        : "—",
      payment.payment_provider_code ?? "Manual",
      payment.payment_status,
      formatMoney(payment.amount_cents, payment.amount_currency),
      formatDate(payment.created_at),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = safeText(value, "—");
      row.append(cell);
    }
    elements.paymentsTableBody.append(row);
  }
  decorateEntityRows(elements.paymentsTableBody, state.payments, "payments");
}

function renderQuotes(quotes) {
  state.quotes = Array.isArray(quotes) ? quotes : [];
  elements.quotesTableBody.replaceChildren();
  elements.quotesLoading.hidden = true;
  elements.quotesEmpty.hidden = state.quotes.length !== 0;
  elements.quotesTableShell.hidden = state.quotes.length === 0;
  for (const quote of state.quotes) {
    const current = quote.current_version ?? {};
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const number = document.createElement("span");
    number.className = "key-name";
    number.textContent = safeText(quote.number, "Unnumbered quote");
    const id = document.createElement("span");
    id.className = "key-id";
    id.textContent = safeText(quote.lago_id, "—");
    identity.append(number, id);
    row.append(identity);
    const values = [
      quote.external_customer_id,
      quote.order_type,
      current.version === undefined ? "—" : String(current.version),
      current.status,
      formatDate(current.updated_at ?? quote.updated_at),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = safeText(value, "—");
      row.append(cell);
    }
    const actions = document.createElement("td");
    actions.className = "actions-column";
    if (state.role === "admin" && current.lago_id) {
      const group = document.createElement("div");
      group.className = "row-actions";
      if (current.status === "draft") {
        group.append(
          quoteActionButton("Edit", "edit-quote", quote.lago_id, current.lago_id),
          quoteActionButton("Approve", "approve-quote", quote.lago_id, current.lago_id),
          quoteActionButton("Void", "void-quote", quote.lago_id, current.lago_id, true),
        );
      } else if (current.status === "voided") {
        group.append(
          quoteActionButton("New version", "clone-quote", quote.lago_id, current.lago_id),
        );
      }
      if (group.childNodes.length > 0) actions.append(group);
      else actions.textContent = "No action";
    } else actions.textContent = state.role === "admin" ? "No action" : "Read only";
    row.append(actions);
    elements.quotesTableBody.append(row);
  }
  decorateEntityRows(elements.quotesTableBody, state.quotes, "quotes");
}

function quoteActionButton(label, action, quoteId, versionId, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "row-action danger" : "row-action";
  button.dataset.action = action;
  button.dataset.quoteId = quoteId;
  button.dataset.quoteVersionId = versionId;
  button.textContent = label;
  return button;
}

async function handleQuoteAction(event) {
  const button = event.target.closest("button[data-quote-version-id]");
  if (!button || state.role !== "admin") return;
  const quote = state.quotes.find((item) => item.lago_id === button.dataset.quoteId);
  if (!quote) return;
  state.selectedQuoteId = quote.lago_id;
  state.selectedQuoteVersionId = button.dataset.quoteVersionId;
  if (button.dataset.action === "edit-quote") return openEditQuoteDialog(quote);
  if (button.dataset.action === "clone-quote") {
    button.disabled = true;
    try {
      await requestJson(`${quoteVersionEndpoint(button.dataset.quoteVersionId)}/clone`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      await refreshQuotes();
    } catch (error) {
      showPageError(errorMessage(error));
    } finally {
      button.disabled = false;
    }
    return;
  }
  state.confirmMode = button.dataset.action;
  const approving = button.dataset.action === "approve-quote";
  elements.confirmTitle.textContent = approving ? "Approve quote?" : "Void quote?";
  elements.confirmCopy.textContent = approving
    ? "Approval locks this quote version from further editing."
    : "Voiding removes the draft share token while retaining audit history.";
  elements.confirmAction.textContent = approving ? "Approve quote" : "Void quote";
  elements.confirmError.hidden = true;
  elements.confirmDialog.showModal();
}

function openCreateQuoteDialog() {
  if (state.customers.length === 0) {
    showPageError("Create a customer before creating a quote.");
    return;
  }
  state.quoteFormMode = "create";
  elements.quoteForm.reset();
  populateQuoteSelectors();
  elements.quoteFormTitle.textContent = "Create quote";
  elements.quoteFormCopy.textContent = "Create a new draft quote.";
  elements.quoteCustomer.disabled = false;
  elements.quoteOrderType.disabled = false;
  elements.quoteSubscription.disabled = false;
  elements.quoteBillingItems.value = "[]";
  elements.submitQuoteForm.textContent = "Create quote";
  elements.quoteFormError.hidden = true;
  elements.quoteFormDialog.showModal();
}

function openEditQuoteDialog(quote) {
  state.quoteFormMode = "edit";
  elements.quoteForm.reset();
  populateQuoteSelectors();
  elements.quoteCustomer.value = quote.lago_customer_id;
  elements.quoteOrderType.value = quote.order_type;
  elements.quoteSubscription.value = quote.lago_subscription_id ?? "";
  elements.quoteCustomer.disabled = true;
  elements.quoteOrderType.disabled = true;
  elements.quoteSubscription.disabled = true;
  elements.quoteContent.value = quote.current_version?.content ?? "";
  elements.quoteBillingItems.value = JSON.stringify(
    quote.current_version?.billing_items ?? [],
    null,
    2,
  );
  elements.quoteFormTitle.textContent = "Edit quote draft";
  elements.quoteFormCopy.textContent = `Update ${quote.number}.`;
  elements.submitQuoteForm.textContent = "Save draft";
  elements.quoteFormError.hidden = true;
  elements.quoteFormDialog.showModal();
}

function populateQuoteSelectors() {
  replaceSelectOptions(
    elements.quoteCustomer,
    state.customers,
    (item) => item.lago_id,
    (item) => `${safeText(item.name, "Unnamed customer")} (${item.external_id})`,
  );
  elements.quoteSubscription.replaceChildren(new Option("None", ""));
  for (const subscription of state.subscriptions) {
    elements.quoteSubscription.append(new Option(subscription.external_id, subscription.lago_id));
  }
}

async function submitQuoteForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.quoteFormDialog.close();
  let billingItems;
  try {
    billingItems = JSON.parse(elements.quoteBillingItems.value);
    if (!Array.isArray(billingItems)) throw new Error("invalid_items");
  } catch {
    elements.quoteFormError.textContent = "Billing items must be a JSON array.";
    elements.quoteFormError.hidden = false;
    return;
  }
  const create = state.quoteFormMode === "create";
  const quote = state.quotes.find((item) => item.lago_id === state.selectedQuoteId);
  const current = quote?.current_version;
  setBusy(elements.submitQuoteForm, true, create ? "Creating…" : "Saving…");
  try {
    await requestJson(create ? endpoints.quotes : quoteVersionEndpoint(current.lago_id), {
      method: create ? "POST" : "PUT",
      ...(create ? { headers: { "Idempotency-Key": crypto.randomUUID() } } : {}),
      body: create
        ? {
            quote: {
              customer_id: elements.quoteCustomer.value,
              order_type: elements.quoteOrderType.value,
              subscription_id: optionalFormValue(elements.quoteSubscription.value),
              owner_ids: [],
              content: optionalFormValue(elements.quoteContent.value),
              billing_items: billingItems,
            },
          }
        : {
            quote_version: {
              lock_version: current.lock_version,
              content: optionalFormValue(elements.quoteContent.value),
              billing_items: billingItems,
            },
          },
    });
    elements.quoteFormDialog.close();
    await refreshQuotes();
  } catch (error) {
    elements.quoteFormError.textContent = errorMessage(error);
    elements.quoteFormError.hidden = false;
  } finally {
    setBusy(elements.submitQuoteForm, false, create ? "Create quote" : "Save draft");
  }
}

function renderDataExports(exports) {
  state.dataExports = Array.isArray(exports) ? exports : [];
  elements.dataExportsTableBody.replaceChildren();
  elements.dataExportsLoading.hidden = true;
  elements.dataExportsEmpty.hidden = state.dataExports.length !== 0;
  elements.dataExportsTableShell.hidden = state.dataExports.length === 0;
  for (const item of state.dataExports) {
    const row = document.createElement("tr");
    const values = [
      item.lago_id,
      item.resource_type,
      item.status,
      item.row_count === null ? "—" : String(item.row_count),
      item.byte_size === null ? "—" : `${item.byte_size} bytes`,
      formatDate(item.created_at),
      "Status only",
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = safeText(value, "—");
      row.append(cell);
    }
    elements.dataExportsTableBody.append(row);
  }
  decorateEntityRows(elements.dataExportsTableBody, state.dataExports, "data-exports");
}

function renderWebhookEndpoints(endpoints) {
  state.webhookEndpoints = Array.isArray(endpoints) ? endpoints : [];
  elements.webhookEndpointsTableBody.replaceChildren();
  elements.webhookEndpointsLoading.hidden = true;
  elements.webhookEndpointsEmpty.hidden = state.webhookEndpoints.length !== 0;
  elements.webhookEndpointsTableShell.hidden = state.webhookEndpoints.length === 0;
  for (const endpoint of state.webhookEndpoints) {
    const row = document.createElement("tr");
    const values = [
      endpoint.name ?? endpoint.lago_id,
      endpoint.webhook_url,
      endpoint.signature_algo,
      Array.isArray(endpoint.event_types) ? endpoint.event_types.join(", ") : "All events",
      formatDate(endpoint.created_at),
      "Read only",
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = safeText(value, "—");
      row.append(cell);
    }
    elements.webhookEndpointsTableBody.append(row);
  }
  decorateEntityRows(
    elements.webhookEndpointsTableBody,
    state.webhookEndpoints,
    "webhook-endpoints",
  );
}

function renderDunningCampaigns(campaigns) {
  state.dunningCampaigns = Array.isArray(campaigns) ? campaigns : [];
  elements.dunningTableBody.replaceChildren();
  elements.dunningLoading.hidden = true;
  elements.dunningEmpty.hidden = state.dunningCampaigns.length !== 0;
  elements.dunningTableShell.hidden = state.dunningCampaigns.length === 0;
  for (const campaign of state.dunningCampaigns) {
    const row = document.createElement("tr");
    const values = [
      `${safeText(campaign.name, "Unnamed")} · ${campaign.code}`,
      `${campaign.max_attempts} every ${campaign.days_between_attempts}d`,
      (campaign.thresholds ?? [])
        .map((threshold) => formatMoney(threshold.amount_cents, threshold.currency))
        .join(", "),
      campaign.applied_to_organization ? "Organization default" : "Assigned customers",
      String(campaign.customers_count ?? 0),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = safeText(value, "—");
      row.append(cell);
    }
    const actionCell = document.createElement("td");
    if (state.role === "admin") {
      const actions = document.createElement("div");
      actions.className = "row-actions";
      actions.append(
        dunningActionButton("Edit", "edit-dunning", campaign.code),
        dunningActionButton("Delete", "delete-dunning", campaign.code, true),
      );
      actionCell.append(actions);
    } else {
      actionCell.textContent = "Read only";
      actionCell.className = "muted";
    }
    row.append(actionCell);
    elements.dunningTableBody.append(row);
  }
  decorateEntityRows(elements.dunningTableBody, state.dunningCampaigns, "dunning-campaigns");
}

function renderPaymentRequests(requests) {
  state.paymentRequests = Array.isArray(requests) ? requests : [];
  elements.paymentRequestsTableBody.replaceChildren();
  elements.paymentRequestsLoading.hidden = true;
  elements.paymentRequestsEmpty.hidden = state.paymentRequests.length !== 0;
  elements.paymentRequestsTableShell.hidden = state.paymentRequests.length === 0;
  for (const request of state.paymentRequests) {
    const row = document.createElement("tr");
    const values = [
      request.customer?.external_id,
      formatMoney(request.amount_cents, request.amount_currency),
      request.payment_status,
      String(Array.isArray(request.invoices) ? request.invoices.length : 0),
      formatDate(request.created_at),
      "Read only",
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = safeText(value, "—");
      row.append(cell);
    }
    elements.paymentRequestsTableBody.append(row);
  }
}

function dunningActionButton(label, action, code, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "row-action danger" : "row-action";
  button.dataset.action = action;
  button.dataset.dunningCode = code;
  button.textContent = label;
  return button;
}

function handleDunningAction(event) {
  const button = event.target.closest("button[data-dunning-code]");
  if (!button || state.role !== "admin") return;
  const campaign = state.dunningCampaigns.find(
    (candidate) => candidate.code === button.dataset.dunningCode,
  );
  if (!campaign) return;
  if (button.dataset.action === "edit-dunning") openEditDunningDialog(campaign);
  if (button.dataset.action === "delete-dunning") openDunningDeletion(campaign);
}

function openCreateDunningDialog() {
  state.dunningFormMode = "create";
  state.selectedDunningCode = null;
  elements.dunningForm.reset();
  elements.dunningFormTitle.textContent = "Create dunning campaign";
  elements.dunningDays.value = "3";
  elements.dunningAttempts.value = "3";
  elements.dunningThresholds.value = '[{"amount_cents":1000,"currency":"USD"}]';
  elements.dunningFormError.hidden = true;
  elements.submitDunningForm.textContent = "Create campaign";
  elements.dunningFormDialog.showModal();
}

function openEditDunningDialog(campaign) {
  state.dunningFormMode = "edit";
  state.selectedDunningCode = campaign.code;
  elements.dunningFormTitle.textContent = "Edit dunning campaign";
  elements.dunningName.value = formValue(campaign.name);
  elements.dunningCode.value = formValue(campaign.code);
  elements.dunningDays.value = String(campaign.days_between_attempts);
  elements.dunningAttempts.value = String(campaign.max_attempts);
  elements.dunningDescription.value = formValue(campaign.description);
  elements.dunningThresholds.value = JSON.stringify(campaign.thresholds ?? [], null, 2);
  elements.dunningBcc.value = Array.isArray(campaign.bcc_emails)
    ? campaign.bcc_emails.join(", ")
    : "";
  elements.dunningApplied.checked = campaign.applied_to_organization === true;
  elements.dunningFormError.hidden = true;
  elements.submitDunningForm.textContent = "Save campaign";
  elements.dunningFormDialog.showModal();
}

async function submitDunningForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.dunningFormDialog.close();
  if (!elements.dunningForm.reportValidity()) return;
  let thresholds;
  try {
    thresholds = JSON.parse(elements.dunningThresholds.value);
    if (!Array.isArray(thresholds)) throw new Error();
  } catch {
    elements.dunningFormError.textContent = "Thresholds must be a JSON array.";
    elements.dunningFormError.hidden = false;
    return;
  }
  const create = state.dunningFormMode === "create";
  setBusy(elements.submitDunningForm, true, create ? "Creating…" : "Saving…");
  try {
    await requestJson(
      create ? endpoints.dunningCampaigns : dunningEndpoint(state.selectedDunningCode),
      {
        method: create ? "POST" : "PUT",
        body: {
          dunning_campaign: {
            name: elements.dunningName.value.trim(),
            code: elements.dunningCode.value.trim(),
            description: optionalFormValue(elements.dunningDescription.value),
            days_between_attempts: Number(elements.dunningDays.value),
            max_attempts: Number(elements.dunningAttempts.value),
            thresholds,
            bcc_emails: elements.dunningBcc.value
              .split(",")
              .map((email) => email.trim())
              .filter(Boolean),
            applied_to_organization: elements.dunningApplied.checked,
          },
        },
      },
    );
    elements.dunningFormDialog.close();
    await refreshDunningCampaigns();
  } catch (error) {
    elements.dunningFormError.textContent = errorMessage(error);
    elements.dunningFormError.hidden = false;
  } finally {
    setBusy(elements.submitDunningForm, false, create ? "Create campaign" : "Save campaign");
  }
}

function openDunningDeletion(campaign) {
  state.confirmMode = "delete-dunning";
  state.selectedDunningCode = campaign.code;
  elements.confirmError.hidden = true;
  elements.confirmTitle.textContent = "Delete dunning campaign?";
  elements.confirmCopy.textContent = `Deleting “${safeText(campaign.name, "Unnamed campaign")}” clears its active assignments and attempt counters.`;
  elements.confirmAction.textContent = "Delete campaign";
  elements.confirmDialog.showModal();
}

function openCreateDataExportDialog() {
  elements.dataExportForm.reset();
  elements.dataExportFilters.value = "{}";
  elements.dataExportFormError.hidden = true;
  elements.dataExportFormDialog.showModal();
}

async function submitDataExportForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.dataExportFormDialog.close();
  let filters;
  try {
    filters = JSON.parse(elements.dataExportFilters.value);
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new Error();
  } catch {
    elements.dataExportFormError.textContent = "Filters must be a JSON object.";
    elements.dataExportFormError.hidden = false;
    return;
  }
  setBusy(elements.submitDataExportForm, true, "Creating…");
  try {
    await requestJson(endpoints.dataExports, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        data_export: { format: "csv", resource_type: elements.dataExportResource.value, filters },
      },
    });
    elements.dataExportFormDialog.close();
    await refreshDataExports();
  } catch (error) {
    elements.dataExportFormError.textContent = errorMessage(error);
    elements.dataExportFormError.hidden = false;
  } finally {
    setBusy(elements.submitDataExportForm, false, "Create export");
  }
}

function openCreateCreditNoteDialog() {
  const invoices = state.invoices.filter((invoice) => invoice.status === "finalized");
  if (invoices.length === 0) {
    showPageError("A finalized invoice is required before creating a credit note.");
    return;
  }
  elements.creditNoteForm.reset();
  replaceSelectOptions(
    elements.creditNoteInvoice,
    invoices,
    (item) => item.lago_id,
    (item) => `${safeText(item.number, "Unnumbered")} · ${item.external_customer_id}`,
  );
  elements.creditNoteItems.value = JSON.stringify(
    [{ fee_id: invoices[0]?.fees?.[0]?.lago_id ?? "", amount_cents: 1 }],
    null,
    2,
  );
  elements.creditNoteAmount.value = "1";
  elements.creditNoteFormError.hidden = true;
  elements.creditNoteFormDialog.showModal();
}

async function submitCreditNoteForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.creditNoteFormDialog.close();
  if (!elements.creditNoteForm.reportValidity()) return;
  let items;
  try {
    items = JSON.parse(elements.creditNoteItems.value);
    if (!Array.isArray(items) || items.length === 0) throw new Error("invalid_items");
  } catch {
    elements.creditNoteFormError.textContent = "Items must be a non-empty JSON array.";
    elements.creditNoteFormError.hidden = false;
    return;
  }
  setBusy(elements.submitCreditNoteForm, true, "Creating…");
  try {
    await requestJson(endpoints.creditNotes, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        credit_note: {
          invoice_id: elements.creditNoteInvoice.value,
          reason: elements.creditNoteReason.value,
          description: optionalFormValue(elements.creditNoteDescription.value),
          credit_amount_cents: Number(elements.creditNoteAmount.value),
          items,
        },
      },
    });
    elements.creditNoteFormDialog.close();
    await refreshCreditNotes();
  } catch (error) {
    elements.creditNoteFormError.textContent = errorMessage(error);
    elements.creditNoteFormError.hidden = false;
  } finally {
    setBusy(elements.submitCreditNoteForm, false, "Create credit note");
  }
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

function handlePricingUnitAction(event) {
  const button = event.target.closest("button[data-pricing-unit-id]");
  if (!button || state.role !== "admin") return;
  const pricingUnit = state.pricingUnits.find(
    (candidate) => candidate.lago_id === button.dataset.pricingUnitId,
  );
  if (pricingUnit) openEditPricingUnitDialog(pricingUnit);
}

function openCreatePricingUnitDialog() {
  state.pricingUnitFormMode = "create";
  state.selectedPricingUnitId = null;
  elements.pricingUnitForm.reset();
  elements.pricingUnitCode.disabled = false;
  elements.pricingUnitTitle.textContent = "Create pricing unit";
  elements.submitPricingUnit.textContent = "Create pricing unit";
  elements.pricingUnitError.hidden = true;
  elements.pricingUnitDialog.showModal();
  elements.pricingUnitName.focus();
}

function openEditPricingUnitDialog(pricingUnit) {
  state.pricingUnitFormMode = "edit";
  state.selectedPricingUnitId = pricingUnit.lago_id;
  elements.pricingUnitName.value = safeText(pricingUnit.name, "");
  elements.pricingUnitCode.value = safeText(pricingUnit.code, "");
  elements.pricingUnitCode.disabled = true;
  elements.pricingUnitShortName.value = safeText(pricingUnit.short_name, "");
  elements.pricingUnitDescription.value = safeText(pricingUnit.description, "");
  elements.pricingUnitTitle.textContent = "Edit pricing unit";
  elements.submitPricingUnit.textContent = "Save pricing unit";
  elements.pricingUnitError.hidden = true;
  elements.pricingUnitDialog.showModal();
  elements.pricingUnitName.focus();
  elements.pricingUnitName.select();
}

async function submitPricingUnitForm(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.pricingUnitDialog.close();
    return;
  }
  if (!elements.pricingUnitForm.reportValidity()) return;
  const creating = state.pricingUnitFormMode === "create";
  const pricingUnit = {
    name: elements.pricingUnitName.value.trim(),
    code: elements.pricingUnitCode.value.trim(),
    short_name: elements.pricingUnitShortName.value.trim(),
    description: optionalFormValue(elements.pricingUnitDescription.value),
  };
  setBusy(elements.submitPricingUnit, true, creating ? "Creating…" : "Saving…");
  elements.pricingUnitError.hidden = true;
  try {
    await requestJson(
      creating ? endpoints.pricingUnits : pricingUnitEndpoint(state.selectedPricingUnitId),
      { method: creating ? "POST" : "PUT", body: { pricing_unit: pricingUnit } },
    );
    elements.pricingUnitDialog.close();
    await refreshPricingUnits();
  } catch (error) {
    elements.pricingUnitError.textContent = errorMessage(error);
    elements.pricingUnitError.hidden = false;
  } finally {
    setBusy(
      elements.submitPricingUnit,
      false,
      creating ? "Create pricing unit" : "Save pricing unit",
    );
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
  if (mode === "delete-alert") {
    if (!state.selectedAlertId) return elements.confirmDialog.close();
    const item = findDetailEntity(entityDetailDefinitions[state.route], state.detailId);
    setBusy(elements.confirmAction, true, "Deleting…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(alertEndpoint(state.selectedAlertId), { method: "DELETE" });
      elements.confirmDialog.close();
      if (item) await renderEntityAlerts(item);
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, "Delete alert");
    }
    return;
  }
  if (mode === "delete-metric" || mode === "delete-feature") {
    const metric = mode === "delete-metric";
    const identifier = metric ? state.selectedMetricCode : state.selectedFeatureId;
    if (!identifier) return elements.confirmDialog.close();
    setBusy(elements.confirmAction, true, "Deleting…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(metric ? metricEndpoint(identifier) : featureEndpoint(identifier), {
        method: "DELETE",
      });
      elements.confirmDialog.close();
      if (metric) await refreshBillableMetrics();
      else await refreshFeatures();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, metric ? "Delete metric" : "Delete feature");
    }
    return;
  }
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

  if (mode === "terminate-applied-coupon") {
    const applied = state.appliedCoupons.find(
      (candidate) => candidate.lago_id === state.selectedAppliedCouponId,
    );
    if (!applied) {
      elements.confirmDialog.close();
      return;
    }
    setBusy(elements.confirmAction, true, "Terminating…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(appliedCouponEndpoint(applied), { method: "DELETE" });
      elements.confirmDialog.close();
      await refreshAppliedCoupons();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, "Terminate application");
    }
    return;
  }

  if (mode === "delete-plan" || mode === "delete-fixed-charge") {
    const path =
      mode === "delete-plan"
        ? planEndpoint(state.selectedPlanCode)
        : fixedChargeEndpoint(state.selectedPlanCode, state.selectedFixedChargeCode);
    setBusy(elements.confirmAction, true, "Deleting…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(path, { method: "DELETE" });
      elements.confirmDialog.close();
      await refreshPlans();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(
        elements.confirmAction,
        false,
        mode === "delete-plan" ? "Delete plan" : "Delete fixed charge",
      );
    }
    return;
  }

  if (mode === "finalize-invoice" || mode === "void-invoice") {
    if (!state.selectedInvoiceId) return elements.confirmDialog.close();
    const finalizing = mode === "finalize-invoice";
    setBusy(elements.confirmAction, true, finalizing ? "Finalizing…" : "Voiding…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(
        `${invoiceEndpoint(state.selectedInvoiceId)}/${finalizing ? "finalize" : "void"}`,
        { method: finalizing ? "PUT" : "POST", ...(finalizing ? {} : { body: {} }) },
      );
      elements.confirmDialog.close();
      await refreshInvoices();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, finalizing ? "Finalize invoice" : "Void invoice");
    }
    return;
  }

  if (mode === "terminate-wallet") {
    if (!state.selectedWalletId) return elements.confirmDialog.close();
    setBusy(elements.confirmAction, true, "Terminating…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(walletEndpoint(state.selectedWalletId), { method: "DELETE" });
      elements.confirmDialog.close();
      await refreshWallets();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, "Terminate wallet");
    }
    return;
  }

  if (mode === "void-credit-note") {
    if (!state.selectedCreditNoteId) return elements.confirmDialog.close();
    setBusy(elements.confirmAction, true, "Voiding…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(`${creditNoteEndpoint(state.selectedCreditNoteId)}/void`, {
        method: "PUT",
      });
      elements.confirmDialog.close();
      await refreshCreditNotes();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, "Void credit note");
    }
    return;
  }

  if (mode === "approve-quote" || mode === "void-quote") {
    if (!state.selectedQuoteVersionId) return elements.confirmDialog.close();
    const approving = mode === "approve-quote";
    setBusy(elements.confirmAction, true, approving ? "Approving…" : "Voiding…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(
        `${quoteVersionEndpoint(state.selectedQuoteVersionId)}/${approving ? "approve" : "void"}`,
        { method: "POST" },
      );
      elements.confirmDialog.close();
      await refreshQuotes();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, approving ? "Approve quote" : "Void quote");
    }
    return;
  }

  if (mode === "delete-dunning") {
    if (!state.selectedDunningCode) return elements.confirmDialog.close();
    setBusy(elements.confirmAction, true, "Deleting…");
    elements.confirmError.hidden = true;
    try {
      await requestJson(dunningEndpoint(state.selectedDunningCode), { method: "DELETE" });
      elements.confirmDialog.close();
      await refreshDunningCampaigns();
    } catch (error) {
      elements.confirmError.textContent = errorMessage(error);
      elements.confirmError.hidden = false;
    } finally {
      setBusy(elements.confirmAction, false, "Delete campaign");
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

async function refreshPricingUnits() {
  try {
    const payload = await requestJson(endpoints.pricingUnits);
    renderPricingUnits(payload.pricing_units);
    hidePageError();
    if (state.route === "pricing-units" && state.detailId) renderEntityDetail();
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

async function refreshCustomers() {
  try {
    const payload = await requestJson(endpoints.customers);
    renderCustomers(payload.customers);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshCoupons() {
  try {
    const payload = await requestJson(endpoints.coupons);
    renderCoupons(payload.coupons);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshAppliedCoupons() {
  try {
    const payload = await requestJson(endpoints.appliedCoupons);
    renderAppliedCoupons(payload.applied_coupons);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshPlans() {
  try {
    const payload = await requestJson(endpoints.plans);
    renderPlans(payload.plans);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshSubscriptions() {
  try {
    const payload = await requestJson(endpoints.subscriptions);
    renderSubscriptions(payload.subscriptions);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshInvoices() {
  try {
    const payload = await requestJson(endpoints.invoices);
    renderInvoices(payload.invoices);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshWallets() {
  try {
    const payload = await requestJson(endpoints.wallets);
    renderWallets(payload.wallets);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshCreditNotes() {
  try {
    const payload = await requestJson(endpoints.creditNotes);
    renderCreditNotes(payload.credit_notes);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshQuotes() {
  try {
    const payload = await requestJson(endpoints.quotes);
    renderQuotes(payload.quotes);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshDataExports() {
  try {
    const payload = await requestJson(endpoints.dataExports);
    renderDataExports(payload.data_exports);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshDunningCampaigns() {
  try {
    const payload = await requestJson(endpoints.dunningCampaigns);
    renderDunningCampaigns(payload.dunning_campaigns);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshBillableMetrics() {
  try {
    const payload = await requestJson(endpoints.billableMetrics);
    renderBillableMetrics(payload.billable_metrics);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

async function refreshFeatures() {
  try {
    const payload = await requestJson(endpoints.features);
    renderFeatures(payload.features);
    hidePageError();
  } catch (error) {
    showPageError(errorMessage(error));
  }
}

function revealOneTimeSecret(secret, title = "Copy this API key now") {
  if (
    typeof secret !== "string" ||
    (!secret.startsWith("lago_") && !secret.includes("/customer-portal/"))
  ) {
    showPageError("The operation completed, but the one-time credential was not returned.");
    return;
  }
  state.oneTimeSecret = secret;
  elements.secretTitle.textContent = title;
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
  elements.secretTitle.textContent = "Copy this API key now";
}

async function createCustomerPortalLink() {
  if (state.role !== "admin" || !state.detailId) return;
  try {
    const payload = await requestJson(`${customerEndpoint(state.detailId)}/portal-token`, {
      method: "POST",
      body: {},
    });
    const link = `https://serp-dev-lago-customer-portal.serpcompany.workers.dev/customer-portal/${payload.portal_token}`;
    revealOneTimeSecret(link, "Copy this customer portal link now");
  } catch (error) {
    showPageError(errorMessage(error));
  }
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
  elements.aiRail.hidden = true;
  elements.aiPanel.hidden = true;
  elements.loading.hidden = true;
  elements.dashboard.hidden = true;
  elements.closed.hidden = false;
}

async function requestJson(path, options = {}) {
  const headers = new Headers({ Accept: "application/json" });
  if (state.organizationSlug) headers.set("X-Operator-Organization", state.organizationSlug);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
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

function metricEndpoint(code) {
  return `${endpoints.billableMetrics}/${encodeURIComponent(code)}`;
}

function featureEndpoint(featureId) {
  return `${endpoints.features}/${encodeURIComponent(featureId)}`;
}

function catalogActivityEndpoint(route, identifier) {
  const base = route === "features" ? endpoints.features : endpoints.billableMetrics;
  return `${base}/${encodeURIComponent(identifier)}/activity`;
}

function aiConversationEndpoint(conversationId) {
  return `${endpoints.aiConversations}/${encodeURIComponent(conversationId)}`;
}

function aiMessagesEndpoint(conversationId) {
  return `${aiConversationEndpoint(conversationId)}/messages`;
}

function webhookLogsEndpoint(endpointId) {
  return `${endpoints.webhookEndpoints}/${encodeURIComponent(endpointId)}/logs`;
}

function dunningEndpoint(code) {
  return `${endpoints.dunningCampaigns}/${encodeURIComponent(code)}`;
}

function sectionEndpoint(code) {
  return `${endpoints.invoiceSections}/${encodeURIComponent(code)}`;
}

function pricingUnitEndpoint(id) {
  return `${endpoints.pricingUnits}/${encodeURIComponent(id)}`;
}

function alertEndpoint(id) {
  return `${endpoints.alerts}/${encodeURIComponent(id)}`;
}

function taxEndpoint(code) {
  return `${endpoints.taxes}/${encodeURIComponent(code)}`;
}

function addOnEndpoint(code) {
  return `${endpoints.addOns}/${encodeURIComponent(code)}`;
}

function customerEndpoint(externalId) {
  return `${endpoints.customers}/${encodeURIComponent(externalId)}`;
}

function customerDocumentSettingsEndpoint(externalId) {
  return `${customerEndpoint(externalId)}/document-settings`;
}

function customerTaxesEndpoint(externalId) {
  return `${customerEndpoint(externalId)}/taxes`;
}

function appliedCouponEndpoint(applied) {
  return `${endpoints.customers}/${encodeURIComponent(applied.external_customer_id)}/applied-coupons/${encodeURIComponent(applied.lago_id)}`;
}

function planEndpoint(code) {
  return `${endpoints.plans}/${encodeURIComponent(code)}`;
}

function planEntitlementsEndpoint(code) {
  return `${planEndpoint(code)}/entitlements`;
}

function fixedChargesEndpoint(planCode) {
  return `${planEndpoint(planCode)}/fixed-charges`;
}

function fixedChargeEndpoint(planCode, chargeCode) {
  return `${fixedChargesEndpoint(planCode)}/${encodeURIComponent(chargeCode)}`;
}

function subscriptionEndpoint(externalId) {
  return `${endpoints.subscriptions}/${encodeURIComponent(externalId)}`;
}

function invoiceEndpoint(invoiceId) {
  return `${endpoints.invoices}/${encodeURIComponent(invoiceId)}`;
}

function walletEndpoint(walletId) {
  return `${endpoints.wallets}/${encodeURIComponent(walletId)}`;
}

function creditNoteEndpoint(creditNoteId) {
  return `${endpoints.creditNotes}/${encodeURIComponent(creditNoteId)}`;
}

function invoiceMetadataEndpoint(invoiceId) {
  return `${invoiceEndpoint(invoiceId)}/metadata`;
}

function invoiceAdjustedFeesEndpoint(invoiceId) {
  return `${invoiceEndpoint(invoiceId)}/adjusted-fees`;
}

function labeledSelect(labelText, options) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const select = document.createElement("select");
  for (const [value, text] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  label.append(select);
  return { label, select };
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function documentFilename(contentDisposition, route) {
  const match = contentDisposition?.match(/filename="([^"]+)"/i);
  if (match?.[1]) return match[1].replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return `${route === "credit-notes" ? "credit-note" : route === "payment-receipts" ? "payment-receipt" : "invoice"}.pdf`;
}

function quoteVersionEndpoint(versionId) {
  return `${endpoints.quoteVersions}/${encodeURIComponent(versionId)}`;
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

function optionalNumberFormValue(value) {
  const normalized = value.trim();
  return normalized === "" ? null : Number(normalized);
}

function nullableNumberFormValue(value) {
  return value === null || value === undefined ? "" : String(nonNegativeNumber(value));
}

function isoFormValue(value) {
  return value ? new Date(value).toISOString() : null;
}

function datetimeLocalValue(value) {
  if (typeof value !== "string") return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
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
