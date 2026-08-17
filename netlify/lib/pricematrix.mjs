/**
 * Bygger prismatrisen — jobben som gjør resten av appen rask og riktig.
 *
 * DATAKILDE: /products/ean/{ean}, ett kall per strekkode.
 *
 * Den opplagte løsningen er POST /products/prices-bulk, som tar 100 strekkoder
 * om gangen. Vi brukte den først, og den er feil. Målt på EAN 7048840081950
 * (Lettmelk Q 1,75 l):
 *
 *   prices-bulk        →  2 kjeder:  Spar 33,90, Meny 31,90
 *   /products/ean/     →  6 kjeder:  bl.a. Kiwi 28,80, Coop 29,50
 *
 * Bulk utelot Kiwi, som var billigst. En app som sender deg til Meny for 31,90
 * når Kiwi har 28,80 gjør det motsatte av jobben sin. Derfor betaler vi med
 * ett kall per strekkode, og kjører jobben i en bakgrunnsfunksjon som har
 * 15 minutter i stedet for 30 sekunder.
 *
 * Bulk beholdes til én ting: dypere historikk. Per-EAN gir ~25 dager, bulk gir
 * opptil 90. Vi bruker bulk KUN til historikk, aldri til priser.
 */

import { kassalPost, unwrap, chunk, MIN_INTERVAL_MS } from "./kassal.mjs";
import { fetchEanPrices } from "./products.mjs";
import { readJSON, writeJSON, KEYS } from "./blobs.mjs";
import { isGroceryChain } from "./chains.mjs";
import { positiveNumber, pickBetterHistory, recentPointCount } from "../../public/js/optimizer.js";

/** Gratis-tieren gir maks 90 dager historikk. */
export const HISTORY_DAYS = 90;

/** Kassalapp tar maks 100 strekkoder per bulk-kall. */
const EANS_PER_BULK_CALL = 100;

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

/** Hvor lang tid en full kjøring tar, i sekunder. Brukes til å sette forventninger. */
export function estimateSeconds(eanCount) {
  const calls = eanCount + Math.ceil(eanCount / EANS_PER_BULK_CALL);
  return Math.ceil((calls * MIN_INTERVAL_MS) / 1000);
}

/**
 * Henter dypere prishistorikk via bulk-endepunktet.
 * Her bærer hvert historikkpunkt sin egen kjede, i motsetning til per-EAN-
 * endepunktet der historikken ligger nestet under hver butikkoppføring.
 */
export async function deepHistory(eans, days = HISTORY_DAYS) {
  const out = {};

  for (const part of chunk(eans, EANS_PER_BULK_CALL)) {
    const json = await kassalPost("/products/prices-bulk", {
      eans: part,
      days,
      aggregation: "min",
    });

    for (const row of unwrap(json) ?? []) {
      if (!row?.ean) continue;
      const byChain = {};

      for (const h of row.price_history ?? []) {
        if (!h?.store || !isGroceryChain(h.store)) continue;
        const price = positiveNumber(h.price);
        const date = String(h.date ?? "").slice(0, 10);
        if (price === null || !date) continue;
        (byChain[h.store] ??= []).push({ date, price });
      }

      for (const arr of Object.values(byChain)) {
        arr.sort((a, b) => a.date.localeCompare(b.date));
      }
      out[String(row.ean)] = byChain;
    }
  }

  return out;
}

/**
 * Bygger og lagrer prismatrisen.
 *
 * `onProgress(gjort, totalt)` kalles underveis, slik at bakgrunnsfunksjonen
 * kan skrive framdrift til Blobs og UI-et kan vise at noe skjer.
 */
export async function buildPriceMatrix({ days = HISTORY_DAYS, onProgress } = {}) {
  const startedAt = Date.now();
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
  let feilet = 0;

  for (const [index, ean] of eans.entries()) {
    try {
      const row = await fetchEanPrices(ean);
      calls += 1;
      // En strekkode uten butikker er ikke til salgs noe sted nå.
      if (Object.keys(row.stores).length > 0) byEan[ean] = row;
    } catch (err) {
      // Én strekkode som feiler skal ikke velte hele kjøringen.
      feilet += 1;
      console.error(`[pricematrix] ${ean} feilet:`, err?.message);
    }
    // Ventes på: framdriften skrives til Blobs, og en glemt await ville gitt
    // kappløp mellom skrivingene.
    await onProgress?.(index + 1, eans.length);
  }

  if (feilet) notes.push(`${feilet} strekkode(r) kunne ikke hentes denne gangen.`);

  const utenPris = eans.filter((e) => !byEan[e]);
  if (utenPris.length) {
    notes.push(`${utenPris.length} strekkode(r) er ikke til salgs i noen av kjedene nå.`);
  }

  // Dypere historikk, hvis vi rekker det. Feiler den, står vi igjen med de
  // ~25 dagene per-EAN-endepunktet ga — nok til å regne ut et tilbud-merke.
  if (eans.length) {
    try {
      const deep = await deepHistory(eans, days);
      calls += Math.ceil(eans.length / EANS_PER_BULK_CALL);

      const now = Date.now();
      for (const [ean, byChain] of Object.entries(deep)) {
        const row = byEan[ean];
        if (!row) continue;
        for (const [chain, points] of Object.entries(byChain)) {
          // Ferskest vinner, ikke lengst. /products/ean/ gir 25 punkter, men
          // spredt over produktets hele levetid — Kiwis kyllinghistorikk kom
          // fra april 2023. Bulk gir tettere og ferskere data der den dekker
          // kjeden, og uten den blir hvert tilbud-merke UKJENT.
          row.history[chain] = pickBetterHistory(row.history[chain] ?? [], points, now);
        }
      }

      const ferske = Object.values(byEan).reduce(
        (sum, row) =>
          sum + Object.values(row.history).filter((h) => recentPointCount(h) >= 5).length,
        0,
      );
      console.log(`[pricematrix] ${ferske} kjede-serier har fersk nok historikk til et tilbud-merke.`);
    } catch (err) {
      notes.push("Kunne ikke hente utvidet prishistorikk — tilbud-merkene bygger på kortere periode.");
      console.error("[pricematrix] dypere historikk feilet:", err?.message);
    }
  }

  const matrix = {
    builtAt: new Date().toISOString(),
    days,
    eanCount: eans.length,
    priced: Object.keys(byEan).length,
    calls,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    byEan,
    notes,
  };

  await writeJSON(KEYS.prices, matrix);
  return matrix;
}
