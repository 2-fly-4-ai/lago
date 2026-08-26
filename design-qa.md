# EPD checkout design QA

## Comparison target

- Source visual truth: `/var/folders/k7/8p9szj517nj6p9vlnbjs3rsr0000gn/T/codex-clipboard-0113d1cf-7679-4737-9903-e03e6463ac9e.png`
- Browser-rendered implementation: `docs/evidence/screenshots/epd-checkout-desktop-2026-08-25.png`
- Responsive implementation: `docs/evidence/screenshots/epd-checkout-mobile-390-css-2026-08-25.png`
- Source pixels: 3374 × 1772 at the captured desktop density.
- Desktop implementation pixels/CSS viewport: 2048 × 1076, device scale factor 1.
- Mobile implementation pixels: 390 × 1616 full-page capture from a 390 × 844 CSS viewport, device scale factor 1.
- State: signed staging subscription checkout, EPD Gateway test mode, hosted fields ready, no card entered.
- Density normalization: the source and desktop implementation have the same 1.904:1 viewport ratio and were compared together at a normalized 2048 × 1076 display size. The mobile capture was evaluated independently at its exact CSS width.

## Findings

- No actionable P0, P1, or P2 differences remain.
- [P3] The test-mode banner adds one row above Contact that is absent from the Stripe reference. This is an intentional staging-only safety disclosure and is omitted in production mode.
- [P3] The EPD canary does not reproduce Stripe's wallet rows or Store-owned add-on carousel. Google Pay eligibility depends on the EPD processor and is unsupported by the current Gateway demo processor; Apple Pay tokens cannot be vaulted for this recurring flow; Amazon Pay is not an EPD Collect.js method. The signed Lago snapshot also does not contain Store upsell inventory, so the implementation does not fabricate either surface.

## Required fidelity surfaces

- Fonts and typography: system sans-serif treatment, price hierarchy, labels, totals, and small legal text match the reference's optical scale and weight closely. Wrapping is clean at desktop and 390px.
- Spacing and layout rhythm: the desktop reproduces the two-column summary/payment composition, central content widths, divider, price block, line item, totals, terms, primary action, and footer. Mobile stacks the two regions without horizontal overflow (`scrollWidth = innerWidth = 390`).
- Colors and visual tokens: the implementation preserves the reference's white/soft-gray split, quiet blue-gray text, light borders, and blue primary action. Amber is reserved for the staging-only test disclosure.
- Image quality and asset fidelity: the official SERP SVG from `apps.serp.co` is used and loaded successfully. No placeholder image, CSS drawing, emoji, or handcrafted SVG substitutes the brand mark.
- Copy and content: plan, interval, email, subtotal, discounts/credits, tax, and total are rendered from the locked D1 checkout state. The canary and test-mode disclosures accurately describe the active route.

## Full-view comparison evidence

The source and implementation were opened together. Both show the same primary hierarchy: order summary and total on the left; contact, payment method, terms, action, and provider footer on the right. The EPD implementation intentionally replaces Stripe wallet rows with the real hosted card fields and adds a staging disclosure. No important content is clipped or pushed below an unusable viewport.

## Focused region evidence

The payment region was checked directly after Collect.js initialized. Card number, expiration, and security-code iframe containers were visible with the expected placeholders; the payment button was enabled; the accessibility status read `Secure fields ready`; the two legal links resolved correctly. The official brand image reported a positive natural width. No additional crop was required because the 2048px capture keeps all labels and hosted fields legible.

## Primary interactions and runtime checks

- Collect.js field readiness: passed on desktop and mobile.
- Terms checkbox toggle: passed.
- Terms and Privacy links: passed.
- Desktop horizontal overflow: none.
- Mobile horizontal overflow at 390px: none.
- Browser console errors after the final CSP fix: none.
- Live card submission: intentionally not performed in visual QA; provider transaction behavior remains covered by the forced-Gateway-test integration tests.

## Comparison history

1. First rendered pass found a P2 runtime-quality issue: EPD's hosted library attempted to load its stylesheet and Apple SDK resources outside the CSP. The CSP was narrowed to the provider Gateway and Apple SDK origins, including the exact Apple inline-style hash and font origin. Post-fix browser evidence showed zero console errors on desktop and mobile.
2. Second pass found a P2 brand-fidelity issue: the source's official mark had been represented by a text wordmark. It was replaced with the official SERP SVG asset. Post-fix evidence confirmed the image loaded and retained the reference's compact back/brand treatment.
3. Final pass found no actionable P0/P1/P2 differences.

## Implementation checklist

- [x] Two-column Stripe-comparable desktop composition.
- [x] Responsive 390px stacked layout without overflow.
- [x] Locked server-side plan, email, interval, subtotal, discounts/credits, tax, and total.
- [x] Real EPD hosted card fields.
- [x] Required terms acceptance and server-side consent record.
- [x] Staging-only test disclosure.
- [x] Official SERP brand asset.
- [x] Zero browser console errors.

## Follow-up polish

- If SERP later enables an EPD processor that supports Google Pay for recurring vault-backed payments, add the wallet only after an end-to-end provider qualification pass.
- Keep Store upsells in the Store checkout layer unless the signed Lago checkout contract is explicitly expanded to carry locked add-on inventory and prices.

final result: passed
