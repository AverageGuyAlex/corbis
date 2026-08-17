/**
 * GET  /api/prices        → prismatrisen slik cron-jobben sist bygde den
 * POST /api/prices        → bygg den på nytt nå ("oppdater priser")
 * POST /api/prices?force=1 → bygg på nytt selv om den er fersk
 *
 * Kassalapp henter prisene sine én gang i døgnet, så den daglige cron-jobben
 * er nok i praksis. Knappen finnes for de gangene du vil være sikker før du
 * går ut døra.
 */

import { requireKey, json, errorResponse } from "../lib/auth.mjs";
import { readJSON, KEYS } from "../lib/blobs.mjs";
import { buildPriceMatrix } from "../lib/pricematrix.mjs";

export const config = { path: "/api/prices" };

/** Under dette er matrisen så fersk at en ny bygging er bortkastet. */
const FRESH_MS = 10 * 60 * 1000;

export default async (req) => {
  const denied = requireKey(req);
  if (denied) return denied;

  try {
    if (req.method === "GET") {
      return json(200, await readJSON(KEYS.prices));
    }

    if (req.method !== "POST") {
      return json(405, { error: "Bruk GET eller POST." });
    }

    const force = new URL(req.url).searchParams.get("force") === "1";
    const existing = await readJSON(KEYS.prices);
    const age = existing?.builtAt ? Date.now() - Date.parse(existing.builtAt) : Infinity;

    if (!force && Number.isFinite(age) && age < FRESH_MS) {
      return json(200, { ...existing, skipped: true, reason: "Prisene er under 10 minutter gamle." });
    }

    const matrix = await buildPriceMatrix();
    return json(200, matrix);
  } catch (err) {
    return errorResponse(err);
  }
};
