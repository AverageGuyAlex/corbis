/**
 * Produktsøk og gruppering.
 *
 * Kassalapp sitt /products-endepunkt gir én rad per kjede per vare. Det er
 * nettopp det vi vil ha — hele priskrysset i ett kall — men det betyr at vi
 * må gruppere radene selv på strekkode før de kan vises som kandidater.
 *
 * Merk: search-parameteren matcher BARE produktnavn. Ordfiltreringen din
 * ("ikke marinert", "ikke panert") må derfor gjøres her, etter at svaret er
 * hentet. Det er hele grunnen til at de godkjente strekkodene dine er verdt
 * noe: de er filteret ditt, permanent lagret.
 */

import { kassalGet, kassalGetAll, unwrap } from "./kassal.mjs";
import { isGroceryChain } from "./chains.mjs";

// Delt med nettleseren, slik at server og klient tolker tall likt.
import { positiveNumber } from "../../public/js/optimizer.js";

const norm = (s) => String(s ?? "").toLowerCase().trim();

/**
 * Kassalapp kaller current_unit_price for "kilopris", men /products sier ikke
 * hvilken enhet det er per. Vi utleder den av pakningens vektenhet: masse gir
 * kr/kg, volum gir kr/l. Den daglige prismatrisen bruker feltet
 * current_unit_price_unit fra bulk-endepunktet, som er autoritativt — her
 * holder en utledning, siden søket bare brukes til å plukke kandidater.
 */
export function unitFromWeightUnit(weightUnit) {
  const u = norm(weightUnit);
  if (["g", "hg", "kg"].includes(u)) return "kg";
  if (["ml", "cl", "dl", "l"].includes(u)) return "l";
  return "piece";
}

/** Sant hvis produktet passerer ordfiltrene dine. */
export function matchesWords(product, { include = [], exclude = [] } = {}) {
  const hay = norm([product?.name, product?.brand, product?.vendor].filter(Boolean).join(" "));
  for (const w of exclude) {
    const t = norm(w);
    if (t && hay.includes(t)) return false;
  }
  for (const w of include) {
    const t = norm(w);
    if (t && !hay.includes(t)) return false;
  }
  return true;
}

function chainOf(row) {
  // I ekte svar er `store` et objekt, ikke et array — skjemaet sier array.
  // Vi takler begge, siden endepunktene ikke er konsekvente.
  const stores = Array.isArray(row?.store) ? row.store : row?.store ? [row.store] : [];
  for (const s of stores) {
    if (s?.code) return s.code;
  }
  return null;
}

/**
 * Henter pris og kilopris ut av en rad.
 *
 * De to endepunktene svarer i ulik form, og det er ikke dokumentert:
 *   /products?search=      → current_price: 99          (tall)
 *   /products/ean/{ean}    → current_price: {price: 99, unit_price: 198, date}
 *
 * Uten denne normaliseringen ga Number(current_price) = NaN på EAN-oppslag,
 * og strekkodeskanneren fant aldri noe som helst.
 */
function priceOf(row) {
  const raw = row?.current_price;

  // positiveNumber, ikke Number: Number(null) er 0, ikke NaN. Et manglende
  // prisfelt ble derfor til "0 kr" og butikken med minst data vant alt.
  if (raw !== null && typeof raw === "object") {
    return {
      price: positiveNumber(raw.price),
      unitPrice: positiveNumber(raw.unit_price ?? raw.current_unit_price),
    };
  }

  return {
    price: positiveNumber(raw),
    unitPrice: positiveNumber(row?.current_unit_price),
  };
}

/**
 * Grupperer rader til én kandidat per strekkode, med pris i hver kjede.
 */
export function groupByEan(rows) {
  const byEan = new Map();

  for (const row of rows ?? []) {
    const ean = row?.ean ? String(row.ean) : null;
    if (!ean) continue;

    const chain = chainOf(row);
    if (!chain || !isGroceryChain(chain)) continue;

    // Ekte svar inneholder rader uten butikk og med price: null — varer kjeden
    // ikke har inne nå. De skal ikke telle som tilgjengelige.
    const { price, unitPrice } = priceOf(row);
    if (price === null) continue;

    if (!byEan.has(ean)) {
      byEan.set(ean, {
        ean,
        name: row.name ?? null,
        brand: row.brand ?? null,
        vendor: row.vendor ?? null,
        image: row.image ?? null,
        weight: row.weight ?? null,
        weightUnit: row.weight_unit ?? null,
        category: Array.isArray(row.category) ? row.category.map((c) => c?.name).filter(Boolean) : [],
        chains: {},
      });
    }

    const cand = byEan.get(ean);
    const existing = cand.chains[chain];

    // Bildet mangler ofte på den første raden vi ser, men finnes på en senere.
    if (!cand.image && row.image) cand.image = row.image;
    if (!cand.name && row.name) cand.name = row.name;
    if (cand.weight === null && row.weight != null) {
      cand.weight = row.weight;
      cand.weightUnit = row.weight_unit ?? null;
    }

    // Samme vare kan dukke opp flere ganger for samme kjede. Behold billigste.
    if (!existing || price < existing.price) {
      cand.chains[chain] = {
        price,
        unitPrice,
        unitPriceUnit: unitFromWeightUnit(row.weight_unit),
        url: row.url ?? null,
        // Hver kjede har sitt eget produktbilde. Vi tar vare på det per kjede,
        // slik at bildet følger produktet optimalisereren faktisk valgte.
        image: row.image ?? null,
      };
    }
  }

  // Legg på billigste pris og billigste kilopris, så UI-et kan sortere.
  const out = [];
  for (const cand of byEan.values()) {
    const prices = Object.values(cand.chains);
    cand.bestPrice = prices.length ? Math.min(...prices.map((p) => p.price)) : null;
    const unitPrices = prices.map((p) => p.unitPrice).filter((n) => Number.isFinite(n));
    cand.bestUnitPrice = unitPrices.length ? Math.min(...unitPrices) : null;
    cand.chainCount = prices.length;
    out.push(cand);
  }

  return out;
}

/**
 * Søker etter produkter og returnerer kandidater gruppert på strekkode.
 *
 * `pages` styrer hvor mange sider vi henter. Hver side er et nettverkskall med
 * minst 1,1 sekunds mellomrom, så flere sider koster tid — men gir flere
 * distinkte varer, siden en populær vare kan fylle en hel side med rader fra
 * ulike kjeder.
 */
export async function searchCandidates({
  q,
  categoryId = null,
  include = [],
  exclude = [],
  pages = 3,
  limit = 40,
}) {
  const query = String(q ?? "").trim();
  if (query.length < 3) {
    return { candidates: [], rows: 0, filteredOut: 0, note: "Søkeordet må ha minst 3 tegn." };
  }

  const rows = await kassalGetAll(
    "/products",
    {
      search: query,
      size: 100,
      // MÅ være 1, ikke true. Målt mot ekte API: exclude_without_ean=true
      // returnerer null treff, exclude_without_ean=1 returnerer fullt sett.
      exclude_without_ean: 1,
      //
      // IKKE legg til sort her. Målt på samme søk:
      //   sort=price_asc  → 100 rader, 0 med butikk og pris
      //   sort=name_asc   → 100 rader, 37 brukbare
      //   ingen sort      → 100 rader, 68 brukbare
      // Varer uten pris sorteres først som null, og fyller hele siden med
      // produkter ingen butikk har inne. Vi sorterer på kilopris selv lenger
      // nede, der vi faktisk vet prisene.
      category_id: categoryId ?? undefined,
    },
    pages,
  );

  const kept = rows.filter((r) => matchesWords(r, { include, exclude }));
  const candidates = groupByEan(kept);

  // Billigste kilopris først — det er den rangeringen som faktisk sparer penger.
  candidates.sort((a, b) => {
    const au = a.bestUnitPrice ?? Number.POSITIVE_INFINITY;
    const bu = b.bestUnitPrice ?? Number.POSITIVE_INFINITY;
    if (au !== bu) return au - bu;
    return (a.bestPrice ?? Infinity) - (b.bestPrice ?? Infinity);
  });

  return {
    candidates: candidates.slice(0, limit),
    rows: rows.length,
    filteredOut: rows.length - kept.length,
    truncated: candidates.length > limit,
  };
}

/**
 * Henter alt vi trenger om én strekkode: pris i hver kjede, prishistorikk per
 * kjede, og produktbilde.
 *
 * Dette er kilden prismatrisen bygges på, og valget er målt fram. For
 * EAN 7048840081950 (Lettmelk Q 1,75 l):
 *
 *   POST /products/prices-bulk  →  2 kjeder  (Spar 33,90, Meny 31,90)
 *   GET  /products/ean/{ean}    →  6 kjeder  (bl.a. Kiwi 28,80, Coop 29,50)
 *
 * Bulk er billigere — 100 strekkoder per kall mot ett — men det utelater
 * kjeder, og da anbefaler appen feil butikk. Riktig svar er viktigere enn
 * raskt svar, så vi betaler med ett kall per strekkode.
 */
export async function fetchEanPrices(ean) {
  const json = await kassalGet(`/products/ean/${encodeURIComponent(ean)}`);
  const data = unwrap(json);
  const listings = Array.isArray(data?.products) ? data.products : [];

  const row = {
    name: null,
    image: null,
    weight: null,
    weightUnit: null,
    stores: {},
    history: {},
  };

  for (const listing of listings) {
    const chain = chainOf(listing);
    if (!chain || !isGroceryChain(chain)) continue;

    const { price, unitPrice } = priceOf(listing);
    if (price === null) continue;

    // Første brukbare oppføring gir navn, vekt og reservebilde.
    if (!row.name && listing.name) row.name = listing.name;
    if (!row.image && listing.image) row.image = listing.image;
    if (row.weight === null && listing.weight != null) {
      row.weight = listing.weight;
      row.weightUnit = listing.weight_unit ?? null;
    }

    const existing = row.stores[chain];
    if (!existing || price < existing.price) {
      row.stores[chain] = {
        price,
        unitPrice,
        unitPriceUnit: unitFromWeightUnit(listing.weight_unit ?? row.weightUnit),
        image: listing.image ?? null,
        url: listing.url ?? null,
        lastChecked: listing.current_price?.date ?? null,
      };
    }

    // Historikken ligger nestet under hver butikkoppføring, uten store-felt —
    // i motsetning til bulk-endepunktet, der hvert punkt bærer sin egen kjede.
    const points = (listing.price_history ?? [])
      .map((h) => ({ date: String(h.date ?? "").slice(0, 10), price: positiveNumber(h.price) }))
      .filter((h) => h.date && h.price !== null);

    if (points.length) {
      const merged = [...(row.history[chain] ?? []), ...points];
      const seen = new Map();
      for (const p of merged) seen.set(p.date, p);
      row.history[chain] = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  return row;
}

/** Slår opp én strekkode — brukes av skanneren. */
export async function lookupEan(ean) {
  const json = await kassalGet(`/products/ean/${encodeURIComponent(ean)}`);
  const data = unwrap(json);

  // Endepunktet svarer med et sammenligningsobjekt: { ean, products: [...] }.
  const rows = Array.isArray(data?.products) ? data.products : Array.isArray(data) ? data : [];
  const normalised = rows.map((p) => ({ ...p, ean: data?.ean ?? p.ean ?? ean }));
  const candidates = groupByEan(normalised);

  return { ean: String(ean), candidates };
}
