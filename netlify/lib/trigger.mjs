/**
 * Starter bakgrunnsjobben som bygger prismatrisen.
 *
 * Hvorfor dette trengs: en planlagt funksjon har 30 sekunder, og full
 * prisoppdatering tar minutter fordi hver strekkode koster ett API-kall med
 * 1,1 sekunds mellomrom. En funksjon kan ikke være både planlagt og
 * bakgrunnsfunksjon, så mønsteret blir at den planlagte funksjonen kaller
 * bakgrunnsfunksjonen over HTTP og går av veien.
 *
 * Bakgrunnsfunksjonen svarer 202 med én gang og fortsetter i opptil 15 minutter.
 */

/** Netlify setter URL i produksjon; de andre dekker deploy-previews og lokalt. */
export function siteUrl() {
  return (
    process.env.URL ??
    process.env.DEPLOY_PRIME_URL ??
    process.env.DEPLOY_URL ??
    null
  );
}

/**
 * Returnerer { started: true } hvis jobben er satt i gang, ellers en grunn til
 * at den ikke ble det. Kaster ikke — kalleren skal kunne svare pent uansett.
 */
export async function triggerRefresh() {
  const base = siteUrl();
  if (!base) {
    return { started: false, reason: "Fant ingen side-URL å kalle bakgrunnsfunksjonen på." };
  }

  const key = process.env.APP_PASSWORD;
  if (!key) {
    return { started: false, reason: "APP_PASSWORD mangler, så bakgrunnsjobben kan ikke autentisere." };
  }

  try {
    const res = await fetch(`${base}/api/refresh-run`, {
      method: "POST",
      headers: { "x-corbis-key": key },
    });

    // Bakgrunnsfunksjoner svarer 202 med en gang. Alt annet er uventet.
    if (res.status === 202 || res.ok) return { started: true };
    return { started: false, reason: `Bakgrunnsfunksjonen svarte ${res.status}.` };
  } catch (err) {
    return { started: false, reason: err?.message ?? "Ukjent feil ved oppstart." };
  }
}
