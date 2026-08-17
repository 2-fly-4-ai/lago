# Lago Cloudflare Operator Design QA

Final result: passed

## Comparison target

- Source visual truth:
  `docs/evidence/cloudflare-operator-2026-08-18/04-original-lago-customer-usage.png`
- Additional source visual:
  `docs/evidence/cloudflare-operator-2026-08-18/05-original-lago-customer-billing.png`
- Matched customer-detail comparison:
  `docs/evidence/cloudflare-operator-2026-08-18/14-customer-detail-comparison-final.png`
- Matched customer-analytics comparison:
  `docs/evidence/cloudflare-operator-2026-08-18/16-customer-analytics-comparison-final.png`
- Mobile detail:
  `docs/evidence/cloudflare-operator-2026-08-18/12-operator-customer-detail-mobile.png`
- Mobile table overflow:
  `docs/evidence/cloudflare-operator-2026-08-18/17-operator-plans-mobile-overflow.png`
- Desktop viewport: 1502 × 888 CSS pixels, device scale factor 1.
- Mobile viewport: 390 × 844 CSS pixels, device scale factor 1.

## Resolved findings

- [Resolved P1] Customer detail now uses an organization-slug route, original entity header,
  Overview/Wallets/Analytics/Invoices/Credit notes/Settings tabs, right-hand Details rail, billing
  summary, route-level edit action, and tenant-safe not-found state.
- [Resolved P2] Every admitted list/show family now has a focused deep-linkable detail page. The
  list identity is a real link, reload and browser history work, and a missing identifier cannot
  fall through to another organization.
- [Resolved P2] Mobile tables provide a visible `Scroll for more columns` affordance, remain bounded
  to the viewport, and retain horizontal access to every column.
- [Resolved P2] Inter is bundled locally as a WOFF2 asset under the same-origin CSP with its SIL OFL
  license. Browser verification confirmed `document.fonts.check("14px Inter")`.

## Required fidelity surfaces

- Fonts and typography: self-hosted Inter, weights, scale, line height, truncation, and entity
  hierarchy match the checked-in Lago source closely.
- Spacing and layout rhythm: current 240px `NavLayout` width, grouped navigation, 48px desktop page
  gutters, compact detail header, tab rhythm, 326px details rail, table density, and original radius
  treatment are retained.
- Colors and tokens: original Lago blue actions/selections, grey navigation, white canvas, light
  selected rows, and semantic membership state are mapped to local variables.
- Asset fidelity: every visible UI icon and the Lago mark comes from the checked-in source asset
  set. No custom inline SVG, CSS drawing, emoji, or text-glyph UI icon is used.
- Copy and content: retained capabilities use realistic synthetic rows. Unsupported controls remain
  visible in their original hierarchy as explicit unavailable states without claiming parity.
- States and interactions: real organization-slug routes, direct deep links, reload, back/forward,
  customer tabs, generic entity links, native dialogs, Escape close, mobile navigation, two-org
  switching, viewer restrictions, and tenant-specific empty/missing states were exercised.
- Accessibility: semantic navigation and tables, current-page state, labeled organization menu,
  skip link, native dialogs, reduced-motion behavior, and visible keyboard targets are present. The
  desktop Customers state exposed 31 ordered focusable links/buttons with no negative tab indexes.
- Responsive behavior: 390px screenshots verify off-canvas navigation, stacked actions, detail-card
  reflow, tab scrolling, and discoverable table overflow without document-width overflow.
- Browser console errors: none in the exercised local or deployed states.

## Comparison history

1. The initial deployment used a custom SERP dashboard, one long hash-anchor document, text-glyph
   icons, and no organization switcher.
2. The first parity pass restored the original Lago navigation hierarchy, source icons, focused
   list routes, original color/spacing system, and real organization-slug history.
3. The first mobile capture exposed hidden navigation labels; the inherited rule was corrected and
   verified in `09-operator-parity-navigation-mobile-fixed.png`.
4. Dialog testing exposed unreliable Escape handling; a global native-dialog Escape boundary was
   added and retested.
5. Customer detail and generic entity pages removed the final structural mismatch. The two matched
   desktop composites now compare the source and implementation at the same viewport and state.
