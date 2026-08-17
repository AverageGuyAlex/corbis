/**
 * Cron-jobb — starter den daglige prisoppdateringen.
 *
 * Denne gjør bevisst ingenting selv. Planlagte funksjoner har 30 sekunders
 * tidsgrense, og en full prisoppdatering tar minutter fordi hver strekkode
 * koster ett API-kall. En funksjon kan ikke være både planlagt og
 * bakgrunnsfunksjon, så denne kaller refresh-run.mjs og går av veien.
 *
 * Kjøretiden står i netlify.toml (0 5 * * *, altså 05:00 UTC).
 * Manuelt:  netlify functions:invoke refresh
 */

import { triggerRefresh, siteUrl } from "../lib/trigger.mjs";
import { buildPriceMatrix } from "../lib/pricematrix.mjs";

export default async () => {
  // Lokalt under `netlify functions:invoke` finnes det ingen side-URL å kalle.
  // Da kjører vi jobben rett her i stedet — tidsgrensen gjelder ikke for en
  // manuell CLI-kjøring, så det er den enkleste måten å teste på.
  if (!siteUrl()) {
    console.log("[refresh] ingen side-URL — kjører prisoppdateringen direkte (lokal modus).");
    const matrix = await buildPriceMatrix();
    console.log(
      `[refresh] ${matrix.priced}/${matrix.eanCount} strekkoder priset i ${matrix.calls} kall på ${matrix.seconds}s.`,
    );
    for (const note of matrix.notes ?? []) console.log(`[refresh] ${note}`);
    return new Response(null, { status: 204 });
  }

  const result = await triggerRefresh();

  if (result.started) {
    console.log("[refresh] bakgrunnsjobben er startet.");
  } else {
    console.error("[refresh] fikk ikke startet bakgrunnsjobben:", result.reason);
  }

  return new Response(null, { status: 204 });
};
