/**
 * Røyktest mot ekte Kassalapp-API.
 *
 * Denne finnes fordi enhetstestene ikke kunne fange fire feil som alle skyldtes
 * at API-et oppfører seg annerledes enn dokumentasjonen sier: en parameter som
 * må være 1 og ikke true, et felt som er tall på ett endepunkt og objekt på et
 * annet, to ulike kodesett for Coop, og et bulk-endepunkt som utelater kjeder.
 *
 * Den importerer den ekte koden fra netlify/lib/, ikke en kopi, slik at den
 * tester det appen faktisk kjører.
 *
 * Kjør med:  npm run smoke
 * Krever KASSAL_TOKEN i .env eller i miljøet.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Enkel .env-leser, så vi slipper en avhengighet bare for dette.
if (!process.env.KASSAL_TOKEN) {
  try {
    for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* ingen .env — da må tokenet komme fra miljøet */
  }
}

if (!process.env.KASSAL_TOKEN) {
  console.error("KASSAL_TOKEN mangler. Legg den i .env eller i miljøet.");
  process.exit(1);
}

const { searchCandidates, lookupEan } = await import("../netlify/lib/products.mjs");
const { priceChainFor, isGroceryChain } = await import("../netlify/lib/chains.mjs");

let failures = 0;

function check(label, ok, detail = "") {
  const mark = ok ? "  ok  " : " FEIL ";
  console.log(`${mark} ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

// Lettmelk Q 1,75 l — kjent vare som finnes i mange kjeder.
const KJENT_EAN = "7048840081950";

console.log("\n=== Produktsøk ===");
{
  const res = await searchCandidates({ q: "kyllingfilet", pages: 1 });
  check(
    "søk gir treff",
    res.candidates.length > 0,
    `${res.candidates.length} kandidater av ${res.rows} rader`,
  );

  const medBilde = res.candidates.filter((c) => c.image).length;
  check(
    "kandidatene har produktbilde",
    res.candidates.length > 0 && medBilde / res.candidates.length >= 0.8,
    `${medBilde}/${res.candidates.length}`,
  );

  const medPris = res.candidates.filter((c) => Number.isFinite(c.bestPrice)).length;
  check("kandidatene har pris", medPris === res.candidates.length, `${medPris}/${res.candidates.length}`);
}

console.log("\n=== Ordfiltrering ===");
{
  const res = await searchCandidates({ q: "kyllingfilet", exclude: ["marinert", "krydret"], pages: 1 });
  const slapp = res.candidates.filter((c) => /marinert|krydret/i.test(c.name ?? ""));
  check("utelukk-ord fjerner treff", slapp.length === 0, `${res.filteredOut} filtrert bort`);
}

console.log("\n=== Strekkodeoppslag ===");
{
  const res = await lookupEan(KJENT_EAN);
  const cand = res.candidates[0];
  const chains = cand ? Object.keys(cand.chains) : [];

  check("EAN-oppslag gir kandidat", !!cand, cand?.name ?? "");
  check(
    "prisene er tall, ikke NaN",
    chains.length > 0 && chains.every((c) => Number.isFinite(cand.chains[c].price)),
    chains.map((c) => `${c} ${cand?.chains[c].price}`).join(", "),
  );
  check(
    "gir bred kjededekning (minst 5)",
    chains.length >= 5,
    `${chains.length} kjeder: ${chains.join(", ")}`,
  );
  check("Kiwi er med", chains.includes("KIWI"), "Kiwi er ofte billigst og må ikke mangle");
  check("Coop er med", chains.includes("COOP_NO"), "Coop har 42 butikker i Kristiansand");
}

// ---------------------------------------------------------------------------
// Endepunktene, ikke bare biblioteket.
//
// Dette avsnittet finnes fordi en feil slapp helt ut til brukeren: søket ga
// 422 fra Kassalapp på hvert eneste kall, mens testene over var grønne. Årsaken
// lå i search.mjs, ikke i products.mjs — searchParams.get() gir null når en
// parameter mangler, Number(null) er 0, og appen sendte category_id=0.
//
// Bibliotektester kan ikke se sånt. Vi må kalle håndtereren slik nettleseren
// gjør det.
// ---------------------------------------------------------------------------

console.log("\n=== Endepunktene (slik nettleseren kaller dem) ===");
{
  process.env.APP_PASSWORD = "smoketest";
  const KEY = { "x-corbis-key": "smoketest" };

  const search = (await import("../netlify/functions/search.mjs")).default;

  // Nøyaktig den URL-en frontenden lager når du legger til en vare: ingen
  // categoryId, ingen pages.
  const res = await search(new Request("http://x/api/search?q=melk", { headers: KEY }));
  const body = await res.json();

  check("GET /api/search uten valgfrie parametre", res.status === 200, `HTTP ${res.status} ${body.error ?? ""}`);
  check("gir faktiske kandidater", (body.candidates?.length ?? 0) > 0, `${body.candidates?.length ?? 0} treff`);

  const medEkskludering = await search(
    new Request("http://x/api/search?q=melk&exclude=sjokolade", { headers: KEY }),
  );
  check("GET /api/search med utelukk-ord", medEkskludering.status === 200, `HTTP ${medEkskludering.status}`);

  const kort = await search(new Request("http://x/api/search?q=ka", { headers: KEY }));
  check("for kort søk avvises pent med 400", kort.status === 400);

  const utenNokkel = await search(new Request("http://x/api/search?q=melk"));
  check("uten passord gir 401", utenNokkel.status === 401);
}

console.log("\n=== Coop-kodeoversettelsen ===");
{
  check("COOP_EXTRA → COOP_NO", priceChainFor("COOP_EXTRA") === "COOP_NO");
  check("COOP_PRIX → COOP_NO", priceChainFor("COOP_PRIX") === "COOP_NO");
  check("COOP_OBS → COOP_NO", priceChainFor("COOP_OBS") === "COOP_NO");
  check("KIWI → KIWI", priceChainFor("KIWI") === "KIWI");
  check("COOP_NO er en gyldig priskjede", isGroceryChain("COOP_NO"));
  check("COOP_EXTRA er IKKE en priskjede", !isGroceryChain("COOP_EXTRA"), "priser finnes ikke under den koden");
}

console.log(
  failures === 0
    ? "\nAlt grønt.\n"
    : `\n${failures} sjekk(er) feilet.\n`,
);
process.exit(failures === 0 ? 0 : 1);
