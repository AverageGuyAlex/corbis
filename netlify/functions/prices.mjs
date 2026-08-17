/**
 * GET  /api/prices          → prismatrisen + status på en eventuell oppdatering
 * POST /api/prices          → start en oppdatering i bakgrunnen
 * POST /api/prices?force=1  → start selv om matrisen er fersk
 *
 * POST bygger ikke matrisen selv. Full oppdatering er ett API-kall per
 * strekkode og tar minutter, langt over det en vanlig funksjon har. Den
 * starter derfor bakgrunnsfunksjonen og svarer med en gang, og UI-et følger
 * med på framdriften gjennom GET.
 */

import { requireKey, json, errorResponse } from "../lib/auth.mjs";
import { readJSON, KEYS } from "../lib/blobs.mjs";
import { collectEans, estimateSeconds } from "../lib/pricematrix.mjs";
import { triggerRefresh } from "../lib/trigger.mjs";

export const config = { path: "/api/prices" };

/** Under dette er matrisen så fersk at en ny bygging er bortkastet. */
const FRESH_MS = 10 * 60 * 1000;

export default async (req) => {
  const denied = requireKey(req);
  if (denied) return denied;

  try {
    if (req.method === "GET") {
      const [prices, refresh] = await Promise.all([
        readJSON(KEYS.prices),
        readJSON(KEYS.refresh),
      ]);
      return json(200, { ...prices, refresh });
    }

    if (req.method !== "POST") {
      return json(405, { error: "Bruk GET eller POST." });
    }

    const force = new URL(req.url).searchParams.get("force") === "1";
    const [prices, refresh, list] = await Promise.all([
      readJSON(KEYS.prices),
      readJSON(KEYS.refresh),
      readJSON(KEYS.list),
    ]);

    // En kjøring som allerede er i gang skal ikke dobles opp.
    const runAge = refresh?.startedAt ? Date.now() - Date.parse(refresh.startedAt) : Infinity;
    if (refresh?.running && runAge < 15 * 60_000) {
      return json(202, {
        started: false,
        alreadyRunning: true,
        refresh,
        message: "En oppdatering er allerede i gang.",
      });
    }

    const age = prices?.builtAt ? Date.now() - Date.parse(prices.builtAt) : Infinity;
    if (!force && Number.isFinite(age) && age < FRESH_MS) {
      return json(200, {
        started: false,
        skipped: true,
        refresh,
        message: "Prisene er under 10 minutter gamle.",
      });
    }

    const result = await triggerRefresh();
    if (!result.started) {
      return json(503, { started: false, error: result.reason });
    }

    const eanCount = collectEans(list).length;
    return json(202, {
      started: true,
      eanCount,
      estimatedSeconds: estimateSeconds(eanCount),
      message: `Oppdaterer ${eanCount} produkter i bakgrunnen.`,
    });
  } catch (err) {
    return errorResponse(err);
  }
};
