/**
 * Felles hjelpere for funksjonene: JSON-svar, feilsvar og lesing av body.
 *
 * Appen har ingen innlogging. Den som kjenner adressen kan lese og endre
 * handlelista, så hold adressen for deg selv.
 */

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
