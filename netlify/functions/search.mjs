/**
 * GET /api/search?q=kyllingfilet&exclude=marinert,panert
 * GET /api/search?ean=7035620038204        (fra strekkodeskanneren)
 *
 * Brukes når du legger en vare på lista og skal krysse av hva som teller som
 * "samme vare". Det er den ene manuelle jobben i appen, og den gjøres én gang
 * per vare — deretter er filteret ditt permanent.
 *
 * Merk: allerede avviste strekkoder filtreres bort i nettleseren, ikke her.
 * Lista over avviste kan bli lang, og den har ingenting å gjøre i en URL.
 */

import { requireKey, json, errorResponse } from "../lib/auth.mjs";
import { searchCandidates, lookupEan } from "../lib/products.mjs";
import { positiveNumber } from "../../public/js/optimizer.js";

export const config = { path: "/api/search" };

function splitWords(value) {
  return String(value ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export default async (req) => {
  const denied = requireKey(req);
  if (denied) return denied;

  try {
    const url = new URL(req.url);

    const ean = url.searchParams.get("ean");
    if (ean) {
      const digits = ean.replace(/\D/g, "");
      if (digits.length < 6 || digits.length > 14) {
        return json(400, { error: "Strekkoden ser ikke riktig ut." });
      }
      return json(200, await lookupEan(digits));
    }

    const q = url.searchParams.get("q") ?? "";
    if (q.trim().length < 3) {
      return json(400, { error: "Søkeordet må ha minst 3 tegn." });
    }

    // positiveNumber, ikke Number: searchParams.get() gir null når parameteren
    // mangler, og Number(null) er 0 — ikke NaN. Med Number.isInteger(0) === true
    // sendte vi category_id=0 til Kassalapp, som svarte
    // 422 "The selected category id is invalid" på hvert eneste søk.
    // Samme linje gjorde at pages ble 1 i stedet for 3.
    const categoryId = positiveNumber(url.searchParams.get("categoryId"));
    const pages = positiveNumber(url.searchParams.get("pages")) ?? 3;

    const result = await searchCandidates({
      q,
      categoryId,
      include: splitWords(url.searchParams.get("include")),
      exclude: splitWords(url.searchParams.get("exclude")),
      // Hver side er ett nettverkskall med 1,1 sekunds mellomrom. Tre sider
      // tar rundt 3 sekunder og gir nok distinkte varer å velge blant.
      pages: Math.min(Math.max(pages, 1), 3),
    });

    return json(200, { query: q, ...result });
  } catch (err) {
    return errorResponse(err);
  }
};
