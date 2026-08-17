/**
 * GET  /api/candidates  → forslag fra discover-jobben som venter på ja/nei
 * POST /api/candidates  → { itemId, approve: [ean], reject: [ean] }
 *
 * Dette er "nye treff"-innboksen. Hvert ja utvider filteret ditt, hvert nei
 * gjør at varen aldri foreslås igjen. Begge svarene er verdifulle — appen blir
 * mer presis for hver gang du bruker den.
 */

import { requireKey, json, errorResponse, readBody } from "../lib/auth.mjs";
import { readJSON, writeJSON, KEYS } from "../lib/blobs.mjs";

export const config = { path: "/api/candidates" };

function cleanEans(value) {
  if (!Array.isArray(value)) return [];
  const out = new Set();
  for (const e of value) {
    const s = String(e ?? "").replace(/\D/g, "");
    if (s.length >= 6 && s.length <= 14) out.add(s);
  }
  return [...out];
}

export default async (req) => {
  const denied = requireKey(req);
  if (denied) return denied;

  try {
    if (req.method === "GET") {
      const state = await readJSON(KEYS.candidates);
      const byItem = state?.byItem ?? {};
      return json(200, {
        ...state,
        pendingItems: Object.keys(byItem).length,
        pendingCandidates: Object.values(byItem).reduce(
          (sum, entry) => sum + (entry?.candidates?.length ?? 0),
          0,
        ),
      });
    }

    if (req.method !== "POST") {
      return json(405, { error: "Bruk GET eller POST." });
    }

    const body = await readBody(req);
    const itemId = String(body?.itemId ?? "");
    if (!itemId) return json(400, { error: "Mangler itemId." });

    const approve = cleanEans(body?.approve);
    const reject = cleanEans(body?.reject);
    if (approve.length === 0 && reject.length === 0) {
      return json(400, { error: "Ingenting å godkjenne eller avvise." });
    }

    const [list, state] = await Promise.all([readJSON(KEYS.list), readJSON(KEYS.candidates)]);

    const item = (list.items ?? []).find((i) => i.id === itemId);
    if (!item) return json(404, { error: `Fant ingen vare med id "${itemId}".` });

    // Et ja overstyrer et tidligere nei, og omvendt — siste svar gjelder.
    const approved = new Set(item.approvedEans ?? []);
    const rejected = new Set(item.rejectedEans ?? []);

    for (const ean of approve) {
      approved.add(ean);
      rejected.delete(ean);
    }
    for (const ean of reject) {
      rejected.add(ean);
      approved.delete(ean);
    }

    item.approvedEans = [...approved];
    item.rejectedEans = [...rejected];
    list.updatedAt = new Date().toISOString();

    // Fjern det som nå er besvart fra innboksen.
    const handled = new Set([...approve, ...reject]);
    const entry = state?.byItem?.[itemId];
    if (entry) {
      entry.candidates = (entry.candidates ?? []).filter((c) => !handled.has(String(c.ean)));
      if (entry.candidates.length === 0) delete state.byItem[itemId];
    }
    state.updatedAt = new Date().toISOString();

    await Promise.all([writeJSON(KEYS.list, list), writeJSON(KEYS.candidates, state)]);

    return json(200, {
      item: { id: item.id, approvedEans: item.approvedEans, rejectedEans: item.rejectedEans },
      // Prisene må hentes på nytt for at nye strekkoder skal få priser.
      pricesStale: approve.length > 0,
      pendingItems: Object.keys(state.byItem ?? {}).length,
    });
  } catch (err) {
    return errorResponse(err);
  }
};
