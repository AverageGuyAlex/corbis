/**
 * Bakgrunnsfunksjon — bygger hele prismatrisen.
 *
 * Kalles av refresh.mjs (cron) og av POST /api/prices ("oppdater nå"). Den
 * svarer 202 med en gang og fortsetter i opptil 15 minutter, i motsetning til
 * en planlagt funksjon som må være ferdig på 30 sekunder.
 *
 * Full kjøring er ett API-kall per godkjent strekkode med 1,1 sekunds
 * mellomrom, pluss noen få bulk-kall til historikk. 150 strekkoder ≈ 3 minutter.
 *
 * Endepunktet er offentlig, så det er passordbeskyttet — ellers kunne hvem som
 * helst brenne opp rate-limiten din ved å spamme det.
 */

import { requireKey, errorResponse } from "../lib/auth.mjs";
import { buildPriceMatrix } from "../lib/pricematrix.mjs";
import { readJSON, writeJSON, KEYS } from "../lib/blobs.mjs";

export const config = { background: true, path: "/api/refresh-run" };

/** Ikke skriv framdrift oftere enn dette — det er ikke verdt skrivingene. */
const PROGRESS_INTERVAL_MS = 4000;

export default async (req) => {
  const denied = requireKey(req);
  if (denied) return denied;

  const startedAt = new Date().toISOString();

  // Ikke start en ny kjøring hvis en allerede er i gang og fortsatt lever.
  const current = await readJSON(KEYS.refresh);
  const age = current?.startedAt ? Date.now() - Date.parse(current.startedAt) : Infinity;
  if (current?.running && age < 15 * 60_000) {
    console.log("[refresh-run] hopper over — en kjøring startet allerede", current.startedAt);
    return new Response(null, { status: 204 });
  }

  await writeJSON(KEYS.refresh, {
    running: true,
    startedAt,
    finishedAt: null,
    done: 0,
    total: 0,
    error: null,
  });

  try {
    let lastWrite = 0;

    const matrix = await buildPriceMatrix({
      onProgress: async (done, total) => {
        const now = Date.now();
        if (now - lastWrite < PROGRESS_INTERVAL_MS && done !== total) return;
        lastWrite = now;
        await writeJSON(KEYS.refresh, {
          running: true,
          startedAt,
          finishedAt: null,
          done,
          total,
          error: null,
        });
      },
    });

    await writeJSON(KEYS.refresh, {
      running: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      done: matrix.eanCount,
      total: matrix.eanCount,
      error: null,
    });

    console.log(
      `[refresh-run] ${matrix.priced}/${matrix.eanCount} strekkoder priset ` +
        `i ${matrix.calls} kall på ${matrix.seconds}s.`,
    );
    for (const note of matrix.notes ?? []) console.log(`[refresh-run] ${note}`);

    return new Response(null, { status: 204 });
  } catch (err) {
    await writeJSON(KEYS.refresh, {
      running: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      done: 0,
      total: 0,
      error: err?.message ?? "Ukjent feil",
    });
    console.error("[refresh-run] feilet:", err?.message, err?.body ?? "");
    return errorResponse(err);
  }
};
