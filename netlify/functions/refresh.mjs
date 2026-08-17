/**
 * Cron-jobb — henter nye priser for hele handlelista.
 *
 * Kjøretiden er satt i netlify.toml (0 5 * * *, altså 05:00 UTC).
 * Netlify tillater ikke at planlagte funksjoner kalles utenfra, så denne
 * trenger ikke passordsjekk. Du kan kjøre den manuelt med:
 *
 *     netlify functions:invoke refresh
 *
 * eller med "Run now"-knappen under Functions i Netlify-panelet.
 *
 * Den skriver til Netlify Blobs, ikke til repoet — derfor utløser den ingen
 * deploy, og koster ingen deploy-credits.
 */

import { buildPriceMatrix } from "../lib/pricematrix.mjs";

export default async () => {
  const started = Date.now();

  try {
    const matrix = await buildPriceMatrix();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log(
      `[refresh] ${matrix.eanCount} strekkoder i ${matrix.calls} bulk-kall på ${seconds}s. ` +
        `${Object.keys(matrix.byEan).length} fikk prisdata.`,
    );
    for (const note of matrix.notes ?? []) console.log(`[refresh] ${note}`);

    return new Response(null, { status: 204 });
  } catch (err) {
    // Kastes videre slik at kjøringen markeres som feilet i Netlify-loggen.
    console.error("[refresh] feilet:", err?.message, err?.body ?? "");
    throw err;
  }
};
