import type { ShippingProvider } from '../tiktok/types.ts';

/** Normalize carrier names so "UPS", "ups", "U.P.S." all compare equal. */
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Known spellings for the same US carrier. Matching is still done ONLY against the provider list
 * TikTok returns from Get Shipping Providers — this table never invents an ID.
 */
const ALIASES: Record<string, string[]> = {
  ups: ['ups', 'unitedparcelservice', 'upsground', 'upsmailinnovations'],
  usps: ['usps', 'unitedstatespostalservice', 'endicia', 'stamps', 'stampscom'],
  fedex: ['fedex', 'federalexpress', 'fedexground', 'fedexsmartpost'],
  dhlecommerce: ['dhlecommerce', 'dhlecommercesolutions', 'dhlecom', 'dhlglobalmail'],
  dhlexpress: ['dhlexpress', 'dhl'],
  ontrac: ['ontrac'],
  uniuni: ['uniuni'],
  lasership: ['lasership'],
  amazonshipping: ['amazonshipping', 'amazon'],
};

export function carrierFamily(name: string): string | null {
  const n = norm(name);
  for (const [fam, list] of Object.entries(ALIASES)) if (list.includes(n)) return fam;
  for (const [fam, list] of Object.entries(ALIASES)) if (list.some((a) => n.startsWith(a))) return fam;
  return null;
}

export type ProviderMatch = { ok: true; provider: ShippingProvider } | { ok: false; reason: string; candidates: ShippingProvider[] };

/**
 * Map a ShipHero carrier string to exactly ONE TikTok shipping provider.
 * `overrideId` (optional, from settings) must still be present in TikTok's list.
 */
export function resolveProvider(carrier: string, providers: ShippingProvider[], overrideId?: string | null): ProviderMatch {
  if (overrideId) {
    const p = providers.find((x) => x.id === overrideId);
    return p ? { ok: true, provider: p } : { ok: false, reason: `Override provider id ${overrideId} is not in TikTok's provider list`, candidates: providers };
  }
  const exact = providers.filter((p) => norm(p.name) === norm(carrier));
  if (exact.length === 1) return { ok: true, provider: exact[0] };
  const fam = carrierFamily(carrier);
  if (!fam) return { ok: false, reason: `Unknown carrier "${carrier}"`, candidates: providers };
  const famMatches = providers.filter((p) => carrierFamily(p.name) === fam);
  if (famMatches.length === 1) return { ok: true, provider: famMatches[0] };
  if (famMatches.length === 0) return { ok: false, reason: `TikTok lists no provider for carrier "${carrier}"`, candidates: providers };
  return { ok: false, reason: `Carrier "${carrier}" matches ${famMatches.length} TikTok providers — choose one in the dashboard`, candidates: famMatches };
}
