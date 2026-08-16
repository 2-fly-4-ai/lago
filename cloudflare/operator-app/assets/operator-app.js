const endpoints = {
  session: "/api/operator/v1/session",
  organization: "/api/operator/v1/organization",
  billingEntity: "/api/operator/v1/billing-entities/default",
  apiKeys: "/api/operator/v1/api-keys",
  invoiceSections: "/api/operator/v1/invoice-custom-sections",
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
  openCreateCustomer: document.querySelector("#open-create-customer"),
  customersLoading: document.querySelector("#customers-loading"),
  customersEmpty: document.querySelector("#customers-empty"),
  customersEmptyCopy: document.querySelector("#customers-empty-copy"),
  customersTableShell: document.querySelector("#customers-table-shell"),
  customersTableBody: document.querySelector("#customers-table-body"),
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
elements.openCreateCustomer.addEventListener("click", openCreateCustomerDialog);
elements.customersTableBody.addEventListener("click", handleCustomerAction);
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
      customersPayload,
      couponsPayload,
      appliedCouponsPayload,
      plansPayload,
      subscriptionsPayload,
      invoicesPayload,
      walletsPayload,
      creditNotesPayload,
      paymentsPayload,
    ] = await Promise.all([
      requestJson(endpoints.organization),
      requestJson(endpoints.billingEntity),
      requestJson(endpoints.apiKeys),
      requestJson(endpoints.invoiceSections),
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
    ]);
    renderOperator(operator);
    renderOrganization(organizationPayload.organization);
    renderBillingEntity(billingPayload.billing_entity);
    renderKeys(keyPayload.api_keys);
    renderSections(sectionsPayload.invoice_custom_sections);
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
  elements.openCreateCustomer.hidden = !isAdmin;
  elements.openCreateCoupon.hidden = !isAdmin;
  elements.openApplyCoupon.hidden = !isAdmin;
  elements.openCreatePlan.hidden = !isAdmin;
  elements.openCreateFixedCharge.hidden = !isAdmin;
  elements.openCreateSubscription.hidden = !isAdmin;
  elements.openCreateInvoice.hidden = !isAdmin;
  elements.openCreateWallet.hidden = !isAdmin;
  elements.openCreateCreditNote.hidden = !isAdmin;
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
  const name = document.createElement("span");
  name.className = "key-name";
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
  const button = event.target.closest("button[data-customer-external-id]");
  if (!button || state.role !== "admin") return;
  const customer = state.customers.find(
    (candidate) => candidate.external_id === button.dataset.customerExternalId,
  );
  if (customer) openEditCustomerDialog(customer);
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

function openCreatePlanDialog() {
  state.planFormMode = "create";
  state.selectedPlanCode = null;
  elements.planForm.reset();
  elements.planCode.disabled = false;
  elements.planFormTitle.textContent = "Create plan";
  elements.planFormCopy.textContent = "Create a core recurring plan.";
  elements.submitPlanForm.textContent = "Create plan";
  elements.planFormError.hidden = true;
  elements.planFormDialog.showModal();
  elements.planName.focus();
}

function openEditPlanDialog(plan) {
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
    await requestJson(create ? endpoints.plans : planEndpoint(state.selectedPlanCode), {
      method: create ? "POST" : "PUT",
      body: {
        plan: {
          code: elements.planCode.value.trim(),
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
    elements.planFormDialog.close();
    await refreshPlans();
  } catch (error) {
    elements.planFormError.textContent = errorMessage(error);
    elements.planFormError.hidden = false;
  } finally {
    setBusy(elements.submitPlanForm, false, create ? "Create plan" : "Save plan");
  }
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

function sectionEndpoint(code) {
  return `${endpoints.invoiceSections}/${encodeURIComponent(code)}`;
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

function appliedCouponEndpoint(applied) {
  return `${endpoints.customers}/${encodeURIComponent(applied.external_customer_id)}/applied-coupons/${encodeURIComponent(applied.lago_id)}`;
}

function planEndpoint(code) {
  return `${endpoints.plans}/${encodeURIComponent(code)}`;
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
