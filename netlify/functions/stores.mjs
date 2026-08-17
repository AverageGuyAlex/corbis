/**
 * GET  /api/stores            → dine valgte butikker + kjedene de tilhører
 * GET  /api/stores?nearby=1   → søker opp butikker rundt hjemmet ditt
 * PUT  /api/stores            → lagrer valget ditt
 *
 * Dette er Kristiansand-delen av appen. Norske kjeder priser nasjonalt, så
 * "billigst i Kristiansand" betyr i praksis "billigst blant kjedene som har
 * en butikk du faktisk kan gå inn i". Denne funksjonen er det som oversetter
 * mellom de to.
 */

import { requireKey, json, errorResponse, readBody } from "../lib/auth.mjs";
import { kassalGetAll } from "../lib/kassal.mjs";
import { readJSON, writeJSON, KEYS, DEFAULTS } from "../lib/blobs.mjs";
import {
  isGroceryStoreGroup,
  priceChainFor,
  chainLabel,
  storeGroupLabel,
  chainLabels,
  APPROXIMATE_PRICE_CHAINS,
} from "../lib/chains.mjs";

export const config = { path: "/api/stores" };

/** Avstand i luftlinje mellom to punkter, i kilometer. */
function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/**
 * position-feltet er dokumentert som "object" uten nærmere form, så vi tar
 * imot de vanlige variantene i stedet for å anta én.
 */
function positionOf(store) {
  const p = store?.position ?? {};
  const lat = Number(p.lat ?? p.latitude ?? store?.lat);
  const lng = Number(p.lng ?? p.lon ?? p.longitude ?? store?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function normaliseStore(raw, home) {
  const pos = positionOf(raw);
  const group = raw?.group ?? null;
  return {
    id: raw?.id ?? null,
    // `group` er butikkformatet (COOP_EXTRA), `chain` er priskjeden prisene
    // ligger under (COOP_NO). De er ikke det samme, og begge trengs:
    // den ene for å vise riktig butikknavn, den andre for å finne prisene.
    group,
    groupLabel: storeGroupLabel(group),
    chain: priceChainFor(group),
    chainLabel: chainLabel(priceChainFor(group)),
    name: raw?.name ?? "Ukjent butikk",
    address: raw?.address ?? null,
    lat: pos?.lat ?? null,
    lng: pos?.lng ?? null,
    km: pos && home ? haversineKm(home, pos) : null,
    // Formen på openingHours er ikke dokumentert. Vi sender den videre rå og
    // lar frontenden vise det den klarer å tolke.
    openingHours: raw?.openingHours ?? null,
    website: raw?.website ?? null,
  };
}

/**
 * Oppsummerer de valgte butikkene per PRISKJEDE — det optimalisereren trenger.
 *
 * Butikknavnene beholdes, slik at planen kan si «Coop — Coop Extra Grim, 1,4 km»
 * i stedet for bare «Coop». Du skal vite hvilken dør du går inn.
 */
function summariseChains(selected) {
  const out = {};
  for (const s of selected ?? []) {
    const chain = s?.chain ?? priceChainFor(s?.group);
    if (!chain) continue;

    const entry = (out[chain] ??= {
      label: chainLabel(chain),
      storeCount: 0,
      nearestKm: null,
      stores: [],
      // Sant når ett prissett dekker flere butikkformater med reelt ulike
      // priser. UI-et skal si fra om det.
      approximate: APPROXIMATE_PRICE_CHAINS.has(chain),
    });
    entry.storeCount += 1;
    entry.stores.push({
      name: s.name,
      address: s.address,
      km: s.km,
      groupLabel: s.groupLabel ?? storeGroupLabel(s.group),
    });
    if (Number.isFinite(s.km) && (entry.nearestKm === null || s.km < entry.nearestKm)) {
      entry.nearestKm = s.km;
    }
  }
  for (const entry of Object.values(out)) {
    entry.stores.sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
  }
  return out;
}

export default async (req) => {
  const denied = requireKey(req);
  if (denied) return denied;

  try {
    const url = new URL(req.url);

    if (req.method === "PUT") {
      const body = await readBody(req);
      if (!body) return json(400, { error: "Mangler eller ugyldig JSON-body." });

      const lat = Number(body.home?.lat);
      const lng = Number(body.home?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return json(400, { error: "home.lat og home.lng må være tall." });
      }

      const km = Number(body.km);
      const saved = {
        home: {
          lat,
          lng,
          label: String(body.home?.label ?? "").slice(0, 80) || "Hjemme",
        },
        km: Number.isFinite(km) ? Math.min(Math.max(km, 1), 60) : DEFAULTS.stores.km,
        selected: (Array.isArray(body.selected) ? body.selected : [])
          // Frontenden sender butikkformatet; priskjeden utleder vi selv, slik
          // at en gammel lagret liste uten `chain` fortsatt virker.
          .filter((s) => isGroceryStoreGroup(s?.group ?? s?.chain))
          .slice(0, 60)
          .map((s) => ({
            id: s.id ?? null,
            group: s.group ?? s.chain,
            groupLabel: storeGroupLabel(s.group ?? s.chain),
            chain: priceChainFor(s.group ?? s.chain),
            chainLabel: chainLabel(priceChainFor(s.group ?? s.chain)),
            name: String(s.name ?? "").slice(0, 120),
            address: s.address ? String(s.address).slice(0, 200) : null,
            lat: Number.isFinite(Number(s.lat)) ? Number(s.lat) : null,
            lng: Number.isFinite(Number(s.lng)) ? Number(s.lng) : null,
            km: Number.isFinite(Number(s.km)) ? Number(s.km) : null,
            openingHours: s.openingHours ?? null,
          })),
        updatedAt: new Date().toISOString(),
      };

      await writeJSON(KEYS.stores, saved);
      return json(200, {
        ...saved,
        chains: summariseChains(saved.selected),
        chainLabels: chainLabels(),
      });
    }

    if (req.method !== "GET") {
      return json(405, { error: "Bruk GET eller PUT." });
    }

    const saved = await readJSON(KEYS.stores);

    if (url.searchParams.get("nearby") !== "1") {
      return json(200, {
        ...saved,
        chains: summariseChains(saved.selected),
        chainLabels: chainLabels(),
      });
    }

    // Søk opp butikker rundt et punkt.
    const lat = Number(url.searchParams.get("lat") ?? saved.home?.lat);
    const lng = Number(url.searchParams.get("lng") ?? saved.home?.lng);
    const kmParam = Number(url.searchParams.get("km") ?? saved.km);
    const km = Number.isFinite(kmParam) ? Math.min(Math.max(kmParam, 1), 60) : 12;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json(400, { error: "Mangler lat/lng." });
    }

    const home = { lat, lng };
    const raw = await kassalGetAll("/physical-stores", { lat, lng, km, size: 100 }, 3);

    const nearby = raw
      .filter((s) => isGroceryStoreGroup(s?.group))
      .map((s) => normaliseStore(s, home))
      .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));

    return json(200, {
      ...saved,
      home: { ...home, label: saved.home?.label ?? "Hjemme" },
      km,
      nearby,
      nearbyCount: nearby.length,
      chains: summariseChains(saved.selected),
      chainLabels: chainLabels(),
    });
  } catch (err) {
    return errorResponse(err);
  }
};
