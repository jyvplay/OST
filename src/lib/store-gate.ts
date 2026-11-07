/**
 * TT139 (BL-04) — the store surface, and the honest answer when there is none.
 *
 * The Payment Request API is on almost every browser, which tempts a web app to
 * show a price and a Pay button. That would be a fake: Payment Request requires
 * a payment handler the user has installed, and a self-hosted desktop has no
 * merchant of record, no tax handling and no refund path. The Digital Goods API
 * (`getDigitalGoodsService`) is worse — it only exists inside an installed Play
 * / TWA context and throws everywhere else.
 *
 * So this module models the *gate*: it decides which of four legitimate states
 * applies, and refuses to render a purchase control outside the one state where
 * money can actually change hands. Everything else is an entitlement export (the
 * shell's own licence files) or a plain external link, clearly marked.
 */

export type StoreMode =
  | "digital-goods"   // installed Android app with a Play Billing service
  | "external-link"   // a real store page exists and can be opened
  | "self-issued"     // no store: the licence file is the product
  | "unavailable";    // none of the above — show nothing to buy

export interface StoreProbe {
  /** `'getDigitalGoodsService' in window` */
  hasDigitalGoods: boolean;
  /** the service resolved for the given payment method */
  digitalGoodsService: boolean;
  /** installed/standalone display mode */
  installed: boolean;
  /** an absolute https URL to a real store listing, or null */
  storeUrl: string | null;
  /** does this build sell anything at all? */
  sells: boolean;
}

export interface StoreDecision {
  mode: StoreMode;
  /** whether a price and a Pay button may be shown */
  canCharge: boolean;
  /** what the surface says instead, one sentence */
  sentence: string;
  /** sku ids it is legal to request in this mode */
  requestableSkus: string[];
}

export const PRODUCTS = [
  { sku: "fusion.pro", label: "Fusion Pro", priceLabel: "one-time" },
  { sku: "fusion.pro-pack", label: "Pro Pack", priceLabel: "one-time" },
] as const;

export function decideStore(probe: StoreProbe, entitlements: readonly string[]): StoreDecision {
  const owned = new Set(entitlements);
  const requestable = PRODUCTS.map((p) => p.sku).filter((sku) => !owned.has(sku));
  if (!probe.sells) {
    return { mode: "unavailable", canCharge: false, sentence: "This build has everything switched on; there is nothing to buy.", requestableSkus: [] };
  }
  if (probe.hasDigitalGoods && probe.digitalGoodsService && probe.installed) {
    return { mode: "digital-goods", canCharge: true, sentence: "Purchases are handled by the store on this device.", requestableSkus: requestable };
  }
  if (probe.storeUrl) {
    const ok = /^https:\/\//i.test(probe.storeUrl);
    if (!ok) return { mode: "unavailable", canCharge: false, sentence: "The configured store link is not an https address, so it is not offered.", requestableSkus: [] };
    return { mode: "external-link", canCharge: false, sentence: "Buying happens on the store's own page — this app never sees a card number.", requestableSkus: [] };
  }
  return { mode: "self-issued", canCharge: false, sentence: "There is no store here. A licence file you already hold unlocks Pro; the app issues and verifies those itself.", requestableSkus: [] };
}

/**
 * The gate for showing a Pay button, as a separate function because a boolean is
 * easier to test than a sentence. `false` in every mode but digital-goods.
 */
export function mayRenderPayButton(decision: StoreDecision): boolean {
  return decision.mode === "digital-goods" && decision.canCharge && decision.requestableSkus.length > 0;
}

/**
 * Digital Goods requires `itemDetails` for a sku before it will show a price.
 * This validates the shape Google returns so a missing field is a *refusal* with
 * a reason rather than a pay button priced at "undefined".
 */
export function validateItemDetails(item: { itemId?: string; title?: string; price?: { value?: string; currency?: string } }): { ok: boolean; error: string | null } {
  if (!item.itemId) return { ok: false, error: "the store returned no item id" };
  if (!item.title) return { ok: false, error: "the store returned no title" };
  const value = item.price?.value;
  const currency = item.price?.currency;
  if (!value || !/^\d+(\.\d{1,2})?$/.test(value)) return { ok: false, error: "the store returned no usable price" };
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "the store returned no ISO currency code" };
  return { ok: true, error: null };
}
