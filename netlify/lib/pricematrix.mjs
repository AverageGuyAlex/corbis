/**
 * Bygger prismatrisen — den daglige jobben som gjør resten av appen rask.
 *
 * Hele handlelista koster 2–3 nettverkskall: /products/prices-bulk tar 100
 * strekkoder om gangen og svarer med pris i hver kjede pluss 90 dagers
 * historikk. Alt annet i appen leser resultatet fra Netlify Blobs.
 *
 * Delt mellom refresh.mjs (cron) og prices.mjs (knappen "oppdater priser nå"),
 * slik at det bare finnes én versjon av denne logikken.
 */

import { kassalPost, unwrap, chunk } from "./kassal.mjs";
import { readJSON, writeJSON, KEYS } from "./blobs.mjs";
import { isGroceryChain } from "./chains.mjs";

/** Gratis-tieren gir maks 90 dager historikk. */
export const HISTORY_DAYS = 90;

/** Kassalapp tar maks 100 strekkoder per bulk-kall. */
const EANS_PER_CALL = 100;

/** Alle strekkoder handlelista faktisk trenger priser på. */
export function collectEans(list) {
  const set = new Set();
  for (const item of list?.items ?? []) {
    if (item?.lockedEan) {
      set.add(String(item.lockedEan));
      continue;
    }
    for (const ean of item?.approvedEans ?? []) {
      if (ean) set.add(String(ean));
    }
  }
  return [...set];
}

function mapRow(row) {
  const stores = {};
  for (const s of row?.stores ?? []) {
    if (!s?.store || !isGroceryChain(s.store)) continue;
    const price = Number(s.current_price);
    // Null pris betyr at kjeden ikke har varen inne nå. Da skal den ikke
    // telle som tilgjengelig, ellers foreslår vi en butikk som ikke har den.
    if (!Number.isFinite(price)) continue;

    const unitPrice = Number(s.current_unit_price);
    stores[s.store] = {
      price,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
      unitPriceUnit: s.current_unit_price_unit ?? null,
      lastChecked: s.last_checked ?? null,
    };
  }

  const history = {};
  for (const h of row?.price_history ?? []) {
    if (!h?.store || !isGroceryChain(h.store)) continue;
    const price = Number(h.price);
    if (!Number.isFinite(price)) continue;
    (history[h.store] ??= []).push({ date: h.date, price });
  }
  for (const arr of Object.values(history)) {
    arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  return {
    name: row?.name ?? null,
    weight: row?.weight ?? null,
    weightUnit: row?.weight_unit ?? null,
    stores,
    history,
  };
}

export async function buildPriceMatrix({ days = HISTORY_DAYS } = {}) {
  const list = await readJSON(KEYS.list);
  const eans = collectEans(list);
  const notes = [];

  const utenStrekkoder = (list?.items ?? []).filter(
    (i) => !i?.lockedEan && !(i?.approvedEans?.length),
  );
  if (utenStrekkoder.length) {
    notes.push(
      `${utenStrekkoder.length} vare(r) mangler godkjente produkter: ${utenStrekkoder
        .map((i) => i.label ?? i.id)
        .join(", ")}. Søk dem opp og kryss av hva som teller som samme vare.`,
    );
  }

  const byEan = {};
  let calls = 0;

  for (const part of chunk(eans, EANS_PER_CALL)) {
    const json = await kassalPost("/products/prices-bulk", {
      eans: part,
      days,
      aggregation: "min",
    });
    calls += 1;

    for (const row of unwrap(json) ?? []) {
      if (!row?.ean) continue;
      byEan[String(row.ean)] = mapRow(row);
    }
  }

  const utenPris = eans.filter((e) => !byEan[e]);
  if (utenPris.length) {
    notes.push(`${utenPris.length} strekkode(r) ga ingen prisdata fra Kassalapp.`);
  }

  const matrix = {
    builtAt: new Date().toISOString(),
    days,
    eanCount: eans.length,
    calls,
    byEan,
    notes,
  };

  await writeJSON(KEYS.prices, matrix);
  return matrix;
}
