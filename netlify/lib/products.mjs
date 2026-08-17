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
  const stores = Array.isArray(row?.store) ? row.store : row?.store ? [row.store] : [];
  for (const s of stores) {
    if (s?.code) return s.code;
  }
  return null;
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

    const price = Number(row.current_price);
    if (!Number.isFinite(price)) continue;

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
    const unitPrice = Number(row.current_unit_price);
    const existing = cand.chains[chain];

    // Samme vare kan dukke opp flere ganger for samme kjede. Behold billigste.
    if (!existing || price < existing.price) {
      cand.chains[chain] = {
        price,
        unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
        unitPriceUnit: unitFromWeightUnit(row.weight_unit),
        url: row.url ?? null,
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
      exclude_without_ean: true,
      sort: "price_asc",
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
