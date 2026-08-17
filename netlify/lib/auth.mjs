/**
 * Passordsjekk for funksjonene som leser eller skriver dine data.
 *
 * Dette er ikke ekte innlogging. Nettleseren sender passordet i en header
 * over HTTPS, og vi sammenligner det med miljøvariabelen APP_PASSWORD.
 * Det stopper tilfeldig snoking i en handleliste — det er alt det skal gjøre,
 * og det er nok her.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const KEY_HEADER = "x-corbis-key";

/**
 * Sammenligner to hemmeligheter uten å lekke informasjon gjennom hvor lang
 * tid sammenligningen tar. Vi hasher først, slik at bufferne alltid er like
 * lange — timingSafeEqual krever det.
 */
function sameSecret(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Returnerer null hvis forespørselen er godkjent, ellers et ferdig
 * feilsvar som kalleren skal returnere direkte.
 */
export function requireKey(req) {
  const expected = process.env.APP_PASSWORD;

  if (!expected) {
    return json(500, {
      error:
        "APP_PASSWORD mangler. Legg den inn under Site configuration → Environment variables i Netlify (eller i .env lokalt).",
    });
  }

  const given = req.headers.get(KEY_HEADER) ?? "";
  if (!given || !sameSecret(given, expected)) {
    return json(401, { error: "Feil passord." });
  }

  return null;
}

/**
 * Oversetter en kastet feil til et fornuftig HTTP-svar.
 * KassalError bærer statuskoden sin videre, slik at UI-et kan si
 * "tokenet er feil" i stedet for bare "noe gikk galt".
 */
export function errorResponse(err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const safeStatus = status >= 400 && status <= 599 ? status : 500;

  console.error("Corbis-funksjonsfeil:", err?.message, err?.body ?? "");

  return json(safeStatus, {
    error: err?.message ?? "Ukjent feil",
    detail: err?.body ?? undefined,
  });
}

/** Leser JSON-body trygt — tom eller ugyldig body gir null i stedet for kast. */
export async function readBody(req) {
  try {
    const text = await req.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
