# Corbis — designbeslutninger

Skrevet 2026-08-17, før implementasjonen. Beholdt som fasit på *hvorfor* appen
ser ut som den gjør, slik at senere endringer ikke river ut noe med vilje.

## Problemet

Dagens tilbudsapper (Mattilbud, kjedenes egne) viser alle tilbud fra alle
kjeder, inkludert bleier, dyremat og snus. De krever at du leser deg gjennom
støyen, og de svarer ikke på om 39 kr faktisk er billig.

## Snuoperasjonen

Vi bygger ikke en tilbudsfeed. Vi bygger en **handlekurv-optimaliserer**: du
legger inn lista, appen sier hvor du skal handle den.

Det løser filtreringsproblemet ved konstruksjon — du ser bare det du selv har
bedt om — og svaret er konkret: «kjøp disse 6 på Rema, resten på Kiwi, du sparer
94 kr.»

## De fire kjernevalgene

| Valg | Beslutning | Hvorfor |
|---|---|---|
| Kjernen | Handlelista styrer alt | Filtrering løses ved konstruksjon, og svaret blir handlingsrettet |
| Bytte-regel | Billigste tilsvarende vare per kjede, sammenlignet på kr/kg | Egne merker (First Price, Coop Xtra, Prima) er der de store pengene ligger. Kr/kg hindrer at ulike pakningsstørrelser lurer deg |
| Svaret | Optimal splitt over flere butikker, med terskel per stopp | Maksimal besparelse, men appen skal ikke sende deg på en ekstra tur for 12 kr |
| Synk | Netlify Blobs bak et passord | Lista skal være den samme på PC og telefon. localStorage kan ikke det |

## Datakilden og dens hull

[Kassalapp](https://kassal.app/api), gratis hobbytier, 60 kall/min.

Verifisert mot `https://kassal.app/docs/api.json`:

- `GET /physical-stores?lat&lng&km` — butikker rundt et punkt, med `position`,
  `openingHours`, `address` og kjedekode.
- `GET /products?search&store&size&unique` — **uten `unique` gir den én rad per
  kjede per vare**, altså hele priskrysset i ett kall. `size` maks 100.
- `POST /products/prices-bulk` — 100 strekkoder per kall, `days` opptil 90,
  `aggregation: min`. Svarer med `stores[]` og `price_history[]`. Dette er
  motoren: hele handlelista oppdateres i 2–3 kall.
- `current_unit_price` er kilopris rett fra API-et.

**Hullet:** det finnes ingen tilbud-endepunkt. Ingen ferdig kampanjeliste. Vi
regner ut tilbudene fra prishistorikken selv, og det er bedre — en vare som
«settes ned» til sin egen normalpris blir avslørt som ikke-tilbud.

**Fellen:** `search` matcher bare produktnavn. Ordfiltreringen («ikke marinert»)
må skje på vår side, etter at svaret er hentet. Det er hele grunnen til at
`approvedEans`/`rejectedEans` er verdifulle: de er filteret ditt, permanent.

## Arkitekturvalg som koster penger hvis de gjøres feil

**Ingen daglige deployer.** En produksjonsdeploy på Netlify koster 15 credits.
Hadde cron-jobben committet en `prices.json` til repoet, ville Netlify bygd på
nytt hver dag: 450 credits i måneden av de 1000 på Personal-planen. Derfor
skriver cron til Netlify Blobs. Drift ligger under 30 credits/mnd.

**Optimalisereren i nettleseren.** `public/js/optimizer.js` er rene funksjoner
uten nettverk eller DOM. Det gir tre ting: innstillinger kan endres uten
API-kall, logikken kan enhetstestes i `node --test`, og `list.mjs` kan importere
`toBase` derfra så server og klient aldri blir uenige om hvilke enheter som
finnes.

**Tokenet forlater aldri serveren.** Både et sikkerhetskrav og et vilkårskrav
fra Kassalapp.

## To grenser vi designer rundt

**Scheduled functions har 30 sekunders tidsgrense.** `discover.mjs` trenger ett
søk per vare, og rate-limiten tvinger 1,1 sekund mellom kall. 50 varer = 55
sekunder = timeout. Løsning: 15 varer per kjøring pluss en `cursor` i
`candidates`-nøkkelen. Med daglig kjøring sykles hele lista gjennom på 3–4 dager,
og et tidsbudsjett på 24 sekunder sørger for at framdriften alltid blir lagret.

**Kassalapp tåler 60 kall i minuttet.** All trafikk går gjennom en kø i
`netlify/lib/kassal.mjs` som slipper gjennom ett kall per 1,1 sekund, med
respekt for `Retry-After` og eksponentiell backoff på 429 og 5xx.

## Regler vi holder oss til i UI-et

Disse er ikke pynt — de er der for at appen ikke skal lyve.

1. **Dekning før pris.** En restevarebutikk med bare kaffen din til 10 kr skal
   ikke troppe rangeringen. `rankSingle` sorterer på antall dekkede varer først,
   pris deretter. Manglende varer vises, aldri skjules.
2. **Ingen gjettede tall.** Kan vi ikke sammenligne enhetene ærlig, sier vi
   «kan ikke sammenlignes» framfor å regne ut noe som ser riktig ut.
3. **Median, ikke gjennomsnitt.** Én rar dag i historikken skal ikke flytte hva
   vi kaller normalpris.
4. **Forbeholdene står i appen.** Nasjonal prising, daglig oppdatering,
   løsvekt uten strekkode og hva passordet faktisk beskytter — alt synlig
   nederst i planen, ikke bortgjemt i en README.

## Hva ekte API avdekket (2026-08-17)

Hele designet over ble skrevet mot API-dokumentasjonen, uten token. Første
kjøring mot ekte data avdekket **seks feil**. Ingen av dem var mulig å se i
enhetstester, fordi alle skyldtes at API-et oppfører seg annerledes enn
dokumentert. Det er lærdommen: en røyktest mot ekte endepunkt er ikke valgfri
når man bygger på et udokumentert API.

| # | Feil | Hvordan den ble funnet |
|---|---|---|
| 1 | `exclude_without_ean=true` gir 0 treff, `=1` gir fullt sett | Sammenlignet parameterverdier |
| 2 | `sort=price_asc` fyller siden med varer uten pris og butikk — 0 av 100 brukbare rader | Talte brukbare rader per sorteringsvalg |
| 3 | `current_price` er tall på `/products`, objekt på `/products/ean/` | Inspiserte råe svar fra begge |
| 4 | Coop har to kodesett: priser under `COOP_NO`, butikker under `COOP_EXTRA` m.fl. | `store=COOP_EXTRA` ga 0 produkter |
| 5 | `prices-bulk` utelater kjeder — mistet Kiwi, som var billigst | Sammenlignet tre endepunkter på samme EAN |
| 6 | `Number(null)` er `0`, ikke `NaN` — manglende kilopris ble «gratis» | Planen viste 0,00 kr på to varer |

Feil 6 fortjener en merknad, for den er ikke en API-feil men vår egen, og den
var den farligste: `Number.isFinite(Number(null))` er `true`. En vare uten
oppgitt kilopris fikk dermed prisen 0 kr, og butikken med minst data vant hver
sammenligning med gratis varer. Derfor finnes `positiveNumber()` i
`optimizer.js`, og derfor leses hvert pristall gjennom den.

En syvende oppdagelse var ikke en feil, men en datagrense verdt å kjenne:
historikken fra `/products/ean/` er 25 punkter spredt over produktets hele
levetid, ikke de siste 25 dagene. Kiwis kyllinghistorikk kom fra april 2023.
Sammenslåingsregelen måtte derfor foretrekke **ferskest**, ikke **lengst** — se
`pickBetterHistory()`.

## Bevisst utenfor omfang

- Kundeaviser fra eTilbudsavis/Tjek. API-et er privat og udokumentert; skraping
  ville vært skjørt og på tvers av vilkårene.
- Ekte innlogging med brukere. Én husholdning, ett passord.
- Skannerbibliotek for iPhone. `BarcodeDetector` pluss manuelt felt dekker
  behovet; biblioteket kan legges til hvis det viser seg å mangle.
