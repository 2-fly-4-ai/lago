import { ApiError } from "../http";

const publicMessages: Readonly<Record<string, string>> = {
  easy_pay_direct_terms_required: "Accept the Terms of Service and Privacy Policy to continue.",
  invalid_easy_pay_direct_submission: "Check your payment details and phone number.",
  easy_pay_direct_customer_email_required: "Enter a valid email address to continue.",
  easy_pay_direct_checkout_invalid: "This checkout link is invalid. Return to the store for help.",
  easy_pay_direct_checkout_expired: "This checkout link has expired. Return to the store for help.",
  easy_pay_direct_declined: "Your payment was declined. Contact your card issuer for help.",
  easy_pay_direct_processing: "Your payment is being checked. Do not submit another purchase.",
  easy_pay_direct_outcome_unknown:
    "We could not confirm the payment outcome. Contact support before trying another purchase.",
  easy_pay_direct_checkout_conflict:
    "This checkout has already been submitted. Contact support before trying another purchase.",
  easy_pay_direct_checkout_replay_mismatch:
    "This checkout has already been submitted with different details. Contact support before trying another purchase.",
  checkout_tax_quote_required: "Confirm your billing address and updated total before paying.",
  checkout_tax_quote_expired: "Update the total for your billing address before paying.",
};

// Provider diagnostics can include vault identifiers or configuration details.
// Keep the original exception for server-side reconciliation, but never serialize
// arbitrary provider messages, codes or details into the customer payment response.
export function publicEasyPayDirectError(error: ApiError): ApiError {
  const message = Object.hasOwn(publicMessages, error.code) ? publicMessages[error.code] : null;
  return new ApiError(
    error.status,
    message ? error.code : "checkout_payment_review_required",
    message ??
      "We could not complete this checkout. Contact support before trying another purchase.",
  );
}
