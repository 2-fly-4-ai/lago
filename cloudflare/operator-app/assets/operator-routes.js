const scopedOriginalRouteRoots = new Set([
  "customer",
  "plan",
  "invoice",
  "payment",
  "webhook",
  "devtool",
  "settings",
  "create",
  "update",
]);

export function resolveOriginalRouteAlias(segments) {
  const unscoped = originalRouteAlias(segments);
  if (unscoped) return { organizationSlug: null, ...unscoped };
  if (segments.length < 2 || !scopedOriginalRouteRoots.has(segments[1])) return null;

  const scoped = originalRouteAlias(segments.slice(1));
  return scoped ? { organizationSlug: segments[0], ...scoped } : null;
}

export function originalRouteAlias(segments) {
  if (!segments.length) return { route: "customers" };
  const [first, second, third, fourth, fifth, sixth] = segments;
  if (first === "customer" && second) {
    if (third === "subscription" && fourth) return { route: "subscriptions", detailId: fourth };
    if ((third === "wallet" || third === "wallet-details") && fourth)
      return { route: "wallets", detailId: fourth };
    if (third === "payment" && fourth) return { route: "payments", detailId: fourth };
    if (third === "credit-notes" && fourth) return { route: "credit-notes", detailId: fourth };
    if (third === "invoice" && fourth) {
      if (fifth === "credit-notes" && sixth) return { route: "credit-notes", detailId: sixth };
      return { route: "invoices", detailId: fourth };
    }
    if (third === "create-invoice") return { route: "invoices" };
    if (third === "draft-invoices")
      return { route: "customers", detailId: second, detailTab: "invoices" };
    const tabAliases = {
      overview: "overview",
      wallets: "wallets",
      analytics: "analytics",
      invoices: "invoices",
      "credit-notes": "credit-notes",
      settings: "settings",
    };
    return {
      route: "customers",
      detailId: second,
      detailTab: tabAliases[third] ?? "overview",
    };
  }
  if (first === "plan" && second) {
    if (third === "subscription" && fourth) return { route: "subscriptions", detailId: fourth };
    return { route: "plans", detailId: second };
  }
  if (first === "invoice" && second) return { route: "invoices", detailId: second };
  if (first === "payment" && second) return { route: "payments", detailId: second };
  if (first === "webhook" && second) return { route: "webhook-endpoints", detailId: second };
  if (first === "devtool") {
    if (second === "webhooks" && third) return { route: "webhook-endpoints", detailId: third };
    return { route: second === "webhooks" ? "webhook-endpoints" : "api-keys" };
  }
  if (first === "settings") {
    if (second === "billing-entity") return { route: "billing-profile" };
    if (second === "dunnings") return { route: "dunning-campaigns" };
    if (second === "invoice-sections") return { route: "invoice-sections" };
    if (second === "taxes") return { route: "taxes" };
    if (second === "integrations") return { route: "integrations" };
    if (second === "team-and-security") return { route: "team-security" };
    return { route: "overview" };
  }
  if (first === "create") {
    const aliases = {
      "add-on": "add-ons",
      coupons: "coupons",
      payment: "payments",
      plans: "plans",
      tax: "taxes",
    };
    if (aliases[second]) return { route: aliases[second] };
  }
  if (first === "update") {
    const aliases = { "add-on": "add-ons", coupons: "coupons", plan: "plans", tax: "taxes" };
    if (aliases[second]) return { route: aliases[second], detailId: third ?? null };
  }
  const directAliases = {
    "add-ons": "add-ons",
    coupons: "coupons",
    "credit-notes": "credit-notes",
    customers: "customers",
    invoices: "invoices",
    payments: "payments",
    plans: "plans",
    subscriptions: "subscriptions",
    settings: "overview",
    "api-keys": "api-keys",
    "invoice-sections": "invoice-sections",
    taxes: "taxes",
  };
  return directAliases[first] ? { route: directAliases[first] } : null;
}
