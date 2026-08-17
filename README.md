# Corbis

Handlekurv-optimaliserer for dagligvarer i Kristiansand. Du skriver handlelista,
appen sier hvilke butikker som er billigst for akkurat den lista denne uka.

Ikke en tilbudsfeed. Du ser bare varer du selv har lagt inn — derfor slipper du
bleier, dyremat og snus uten å måtte filtrere dem bort.

> **Skal du kjøre din egen kopi?** Du trenger ditt eget API-token fra
> [kassal.app](https://kassal.app/api). Det følger ingen med i dette repoet, og
> gratis-tieren tillater ikke kommersiell bruk. Koden er MIT-lisensiert; det
> gjelder koden, ikke prisdataene.

---

## Slik kommer du i gang

### 1. Hent et API-token

Lag en bruker på [kassal.app](https://kassal.app), gå til API-seksjonen i
profilen og lag en nøkkel. Gratis for hobbybruk: 60 kall per minutt, ingen
kommersiell bruk. Corbis bruker 2–3 kall per døgn i normal drift.

### 2. Kjør lokalt

```bash
npm install
```

Kopier `.env.example` til `.env` og fyll inn de to verdiene:

```
KASSAL_TOKEN=tokenet ditt fra kassal.app
APP_PASSWORD=et langt passord du velger selv
```

Start utviklingsserveren:

```bash
npx netlify dev
```

Kjør testene for prislogikken:

```bash
npm test
```

### 3. Legg den ut på Netlify

Push til GitHub, koble repoet i Netlify, og legg inn de samme to variablene
under **Site configuration → Environment variables**. Uten dem svarer appen
med en tydelig feilmelding om hva som mangler.

Cron-jobbene starter av seg selv etter første publiserte deploy.

### 4. Første gangs oppsett i appen

1. Åpne appen, skriv inn passordet.
2. Gå til **Butikker** og trykk «Søk opp butikker». Kryss av de du realistisk
   kan innom. Har du to Kiwi i nærheten, hold deg til den nærmeste — prisene er
   like.
3. Gå tilbake, trykk **Legg til vare**, søk opp noe du faktisk kjøper, og kryss
   av alt som teller som samme vare. **Ta med butikkenes egne merker** — First
   Price, Coop Xtra, Rema Prima. Det er ofte der pengene ligger.
4. Trykk **Oppdater** i toppen for å hente priser.
5. Planen står under **Plan**-fanen.

---

## Hvordan det virker

```
Nettleser (telefon/PC)          Netlify Functions           Kassalapp API
──────────────────────          ─────────────────           ─────────────
index.html    handleliste ───►  list.mjs        ◄──► Blobs
              + plan
                                search.mjs      ─────────►  GET /products
butikker.html oppsett     ───►  stores.mjs      ─────────►  GET /physical-stores
                                candidates.mjs  ◄──► Blobs

js/optimizer.js ◄── priser ───  prices.mjs      ◄──► Blobs
  (all regning skjer her)

                                refresh.mjs     ─────────►  POST /prices-bulk
                                (cron, daglig)       └──► Blobs

                                discover.mjs    ─────────►  GET /products
                                (cron, 15 varer per kjøring)
```

Tre valg som styrer alt:

1. **Kassalapp-tokenet forlater aldri serveren.** Nettleseren snakker bare med
   appens egne `/api/*`-funksjoner.
2. **Optimalisereren kjører i nettleseren.** Skrur du på «kroner per ekstra
   stopp» eller tar bort en butikk, rangeres alt på nytt umiddelbart — uten et
   eneste API-kall.
3. **Ingen daglige deployer.** Cron-jobbene skriver til Netlify Blobs, ikke til
   repoet. En produksjonsdeploy koster 15 credits; daglig bygging ville kostet
   450 credits i måneden. Slik det er nå koster drift under 30.

### Filene som betyr noe

| Fil | Ansvar |
|---|---|
| `public/js/optimizer.js` | All prisregning. Rene funksjoner, ingen nettverk. Testet i `test/optimizer.test.js` |
| `netlify/lib/kassal.mjs` | Kø og backoff mot Kassalapp, så vi aldri bryter 60/min |
| `netlify/lib/pricematrix.mjs` | Bygger den daglige prismatrisen i 2–3 kall |
| `netlify/functions/discover.mjs` | Leter etter nye produkter, 15 varer per kjøring |

### Tilbud-merkene

Kassalapp har ikke noe tilbud-endepunkt, så merkene regnes ut fra varens egen
90-dagers historikk i den kjeden:

| Merke | Betyr |
|---|---|
| **Tilbud −25 %** | Minst 15 % under medianen siste 60 dager |
| **Laveste på 90 d** | Lavere enn noe vi har registrert, og under medianen |
| **Dyrt nå** | Minst 5 % over medianen — vent hvis du kan |
| *(ingen merke)* | Normalpris, eller for lite historikk til å si noe |

Median, ikke gjennomsnitt: én rar dag i historikken skal ikke flytte hva vi
kaller normalpris. En vare som «settes ned» til sin egen normalpris får ikke
tilbud-merke — det er hele poenget.

---

## Ærlige begrensninger

- **Norske kjeder priser nasjonalt.** «Billigst i Kristiansand» betyr i praksis
  «billigst blant kjedene som har butikk nær deg». Lokale Coop-samvirkelag og
  Obs-varehus kan avvike fra kjedeprisen.
- **Prisene hentes én gang i døgnet og kan være feil.** Dette er
  beslutningsstøtte, ikke en garanti i kassa.
- **Løsvekt mangler ofte strekkode** — bananer, kjøtt over disk, løse
  grønnsaker. Slike varer markeres «kan ikke sammenlignes» framfor å gi et
  misvisende tall.
- **Passordet er ikke ekte innlogging.** Nettleseren sender det i en header
  over HTTPS og funksjonen sammenligner med en miljøvariabel. Det stopper
  tilfeldig snoking i en handleliste, og det er alt det skal gjøre.
- **Strekkodeskanning** bruker nettleserens innebygde `BarcodeDetector`.
  Chrome på Android har den; Safari på iPhone har den ikke. Der den mangler,
  får du et felt for å skrive inn tallene under strekkoden.
- **Kassalapp tillater ikke kommersiell bruk** på gratis-tieren. Corbis er en
  privat app for én husholdning. Ikke gjør den offentlig eller tjen penger på
  den uten en kommersiell avtale.

## Ikke døp om disse

Blobs-store-navnet `corbis` og nøklene `list`, `stores`, `prices`,
`candidates` i `netlify/lib/blobs.mjs`. Endrer du dem, mister du handlelista og
alle godkjente strekkoder.
