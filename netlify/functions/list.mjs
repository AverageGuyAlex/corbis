/**
 * GET /api/list  → handlelista di og innstillingene
 * PUT /api/list  → lagrer dem
 *
 * Lista er selve appen. Hver linje er en *vare-mal*, ikke ett fast produkt:
 * et søkeord, noen ord som skal utelukkes, og strekkodene du har godkjent som
 * "samme vare". Det er de godkjente strekkodene som gjør at bleier og marinert
 * kylling aldri dukker opp igjen.
 */

import { requireKey, json, errorResponse, readBody } from "../lib/auth.mjs";
import { readJSON, writeJSON, KEYS, DEFAULTS } from "../lib/blobs.mjs";

// Gjenbruker enhetstabellen fra optimalisereren, slik at serveren og
// nettleseren aldri kan bli uenige om hvilke enheter som finnes.
import { toBase } from "../../public/js/optimizer.js";

export const config = { path: "/api/list" };

const MAX_ITEMS = 200;
const MAX_EANS_PER_ITEM = 40;
const MAX_WORDS = 20;

function slug(text, fallback) {
  const s = String(text ?? "")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || fallback;
}

function cleanWords(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((w) => String(w ?? "").trim().toLowerCase())
    .filter((w) => w.length > 0 && w.length <= 40)
    .slice(0, MAX_WORDS);
}

function cleanEans(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const e of value) {
    const s = String(e ?? "").replace(/\D/g, "");
    if (s.length >= 6 && s.length <= 14) seen.add(s);
    if (seen.size >= MAX_EANS_PER_ITEM) break;
  }
  return [...seen];
}

function sanitiseItem(raw, index, usedIds) {
  const label = String(raw?.label ?? "").trim().slice(0, 80) || `Vare ${index + 1}`;

  let id = slug(raw?.id ?? label, `vare-${index + 1}`);
  while (usedIds.has(id)) id = `${id}-2`;
  usedIds.add(id);

  const compareBy = raw?.compareBy === "pack" ? "pack" : "unit";

  // Ukjent enhet ville gjort varen usammenlignbar for alltid, så vi faller
  // tilbake til noe som virker i stedet for å lagre noe ødelagt.
  let qtyUnit = String(raw?.qtyUnit ?? "").trim() || (compareBy === "pack" ? "stk" : "kg");
  if (!toBase(1, qtyUnit)) qtyUnit = compareBy === "pack" ? "stk" : "kg";

  const qtyNum = Number(raw?.qty);
  const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.min(qtyNum, 999) : 1;

  const search = String(raw?.search ?? label).trim().slice(0, 80);
  const lockedEan = cleanEans([raw?.lockedEan])[0] ?? null;

  return {
    id,
    label,
    qty,
    qtyUnit,
    compareBy,
    search,
    include: cleanWords(raw?.include),
    exclude: cleanWords(raw?.exclude),
    categoryId: Number.isInteger(raw?.categoryId) ? raw.categoryId : null,
    approvedEans: cleanEans(raw?.approvedEans),
    rejectedEans: cleanEans(raw?.rejectedEans),
    lockedEan,
    // På som standard: alle butikker selger dopapir, bare ikke akkurat ditt
    // merke. Slå den av for varer der bare det ene produktet duger.
    allowSubstitute: raw?.allowSubstitute !== false,
    note: raw?.note ? String(raw.note).slice(0, 200) : null,
  };
}

function sanitiseSettings(raw) {
  const d = DEFAULTS.list.settings;
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  };
  return {
    minSavingsPerStop: num(raw?.minSavingsPerStop, d.minSavingsPerStop, 0, 1000),
    maxStops: Math.trunc(num(raw?.maxStops, d.maxStops, 1, 4)),
    maxKm: num(raw?.maxKm, d.maxKm, 1, 60),
  };
}

export default async (req) => {
  const denied = requireKey(req);
  if (denied) return denied;

  try {
    if (req.method === "GET") {
      return json(200, await readJSON(KEYS.list));
    }

    if (req.method !== "PUT") {
      return json(405, { error: "Bruk GET eller PUT." });
    }

    const body = await readBody(req);
    if (!body) return json(400, { error: "Mangler eller ugyldig JSON-body." });
    if (!Array.isArray(body.items)) return json(400, { error: "items må være en liste." });
    if (body.items.length > MAX_ITEMS) {
      return json(400, { error: `Maks ${MAX_ITEMS} varer på lista.` });
    }

    const usedIds = new Set();
    const saved = {
      items: body.items.map((raw, i) => sanitiseItem(raw, i, usedIds)),
      settings: sanitiseSettings(body.settings),
      updatedAt: new Date().toISOString(),
    };

    await writeJSON(KEYS.list, saved);
    return json(200, saved);
  } catch (err) {
    return errorResponse(err);
  }
};
