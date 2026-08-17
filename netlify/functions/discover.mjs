/**
 * Cron-jobb — leter etter nye produkter som matcher varene på lista di.
 *
 * Dette er det som holder appen fersk uten arbeid: når Kiwi lanserer et nytt
 * eget merke som er billigere enn det du har godkjent, dukker det opp som et
 * forslag du kan si ja eller nei til.
 *
 * VIKTIG DESIGNVALG: planlagte funksjoner har 30 sekunders tidsgrense, og
 * rate-limiten mot Kassalapp tvinger 1,1 sekund mellom hvert kall. Et søk per
 * vare på en liste med 50 varer ville tatt 55 sekunder og timet ut. Derfor tar
 * vi BATCH varer per kjøring og lagrer hvor vi stoppet. Med daglig kjøring
 * sykler vi gjennom hele lista på tre–fire dager, som er mer enn ferskt nok.
 */

import { readJSON, writeJSON, KEYS } from "../lib/blobs.mjs";
import { searchCandidates } from "../lib/products.mjs";

/** Antall varer per kjøring. 15 × ~1,1 s ≈ 17 s, godt innenfor grensen. */
const BATCH = 15;

/** Stopper vi selv før Netlify gjør det, får vi lagret framdriften. */
const TIME_BUDGET_MS = 24_000;

/** Hvor mange forslag vi tar vare på per vare. */
const MAX_SUGGESTIONS = 8;

export default async () => {
  const started = Date.now();

  const [list, state] = await Promise.all([readJSON(KEYS.list), readJSON(KEYS.candidates)]);
  const items = list?.items ?? [];

  if (items.length === 0) {
    console.log("[discover] Handlelista er tom — ingenting å lete etter.");
    return new Response(null, { status: 204 });
  }

  const liveIds = new Set(items.map((i) => i.id));
  // Kast forslag som hører til varer du har slettet.
  const byItem = Object.fromEntries(
    Object.entries(state?.byItem ?? {}).filter(([id]) => liveIds.has(id)),
  );

  let cursor = Number.isInteger(state?.cursor) ? state.cursor : 0;
  if (cursor < 0 || cursor >= items.length) cursor = 0;

  const log = [];
  let processed = 0;

  for (let n = 0; n < Math.min(BATCH, items.length); n++) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      log.push("tidsbudsjettet brukt opp — fortsetter neste kjøring");
      break;
    }

    const item = items[(cursor + n) % items.length];
    processed += 1;

    try {
      const { candidates } = await searchCandidates({
        q: item.search || item.label,
        categoryId: item.categoryId,
        include: item.include,
        exclude: item.exclude,
        pages: 1, // ett kall per vare — det er tidsbudsjettet vårt
        limit: 30,
      });

      const kjent = new Set(
        [...(item.approvedEans ?? []), ...(item.rejectedEans ?? []), item.lockedEan]
          .filter(Boolean)
          .map(String),
      );

      const nye = candidates
        .filter((c) => !kjent.has(String(c.ean)))
        .slice(0, MAX_SUGGESTIONS);

      if (nye.length) {
        byItem[item.id] = {
          label: item.label,
          foundAt: new Date().toISOString(),
          candidates: nye,
        };
      } else {
        delete byItem[item.id];
      }

      log.push(`${item.label}: ${nye.length} nye`);
    } catch (err) {
      // En vare som feiler skal ikke stoppe de andre.
      log.push(`${item.label}: feilet (${err?.message ?? "ukjent"})`);
    }
  }

  await writeJSON(KEYS.candidates, {
    cursor: (cursor + processed) % items.length,
    byItem,
    updatedAt: new Date().toISOString(),
    lastRun: {
      at: new Date().toISOString(),
      processed,
      seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      log,
    },
  });

  console.log(
    `[discover] ${processed} varer på ${((Date.now() - started) / 1000).toFixed(1)}s. ` +
      `${Object.keys(byItem).length} varer har forslag som venter.`,
  );
  for (const line of log) console.log(`[discover] ${line}`);

  return new Response(null, { status: 204 });
};
