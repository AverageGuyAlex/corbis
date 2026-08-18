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

Og røyktesten mot ekte API — denne fanger feil enhetstestene ikke kan se, som at
et felt har ulik form på to endepunkter:

```bash
npm run smoke
```

### 3. Legg den ut på Netlify

Push til GitHub og koble repoet i Netlify: **Add new site → Import an existing
project → GitHub → corbis**.

**Legg inn miljøvariablene før første deploy.** På oppsettsiden, før du trykker
deploy, finnes knappen **Add environment variables**. Legg inn `KASSAL_TOKEN` og
`APP_PASSWORD` der, og huk av «Contains secret values» på begge.

Gjør du det etterpå i stedet, finner du dem under **Project configuration →
Environment variables** — men da må du kjøre en ny deploy for at de skal tre i
kraft, og det koster credits en gang til. Uten variablene svarer appen med en
tydelig feilmelding om hva som mangler.

Med CLI-en, hvis du heller vil det:

```bash
npx netlify env:import .env
```

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
Nettleser (telefon/PC)          Netlify Functions            Kassalapp API
──────────────────────          ─────────────────            ─────────────
index.html    handleliste ───►  list.mjs         ◄──► Blobs
              + plan
                                search.mjs       ─────────►  GET /products
butikker.html oppsett     ───►  stores.mjs       ─────────►  GET /physical-stores
                                candidates.mjs   ◄──► Blobs

js/optimizer.js ◄── priser ───  prices.mjs       ◄──► Blobs
  (all regning skjer her)            │
                                     │ POST starter jobben
                                     ▼
                                refresh-run.mjs  ─────────►  GET /products/ean/{ean}
                                (background, 15 min)   ×N        + POST /prices-bulk
                                     ▲                            (kun historikk)
                                     │ HTTP                  └──► Blobs
                                refresh.mjs
                                (cron, daglig 05:00 UTC)

                                discover.mjs     ─────────►  GET /products
                                (cron, 15 varer per kjøring)
```

Fire valg som styrer alt:

1. **Kassalapp-tokenet forlater aldri serveren.** Nettleseren snakker bare med
   appens egne `/api/*`-funksjoner.
2. **Optimalisereren kjører i nettleseren.** Skrur du på «kroner per ekstra
   stopp» eller tar bort en butikk, rangeres alt på nytt umiddelbart — uten et
   eneste API-kall.
3. **Ingen daglige deployer.** Cron-jobbene skriver til Netlify Blobs, ikke til
   repoet. En produksjonsdeploy koster 15 credits; daglig bygging ville kostet
   450 credits i måneden. Slik det er nå koster drift under 30.
4. **Prisene hentes én strekkode om gangen, i en bakgrunnsfunksjon.** Det er
   dyrere enn bulk-endepunktet, og det er hele poenget — se under.

### Hvorfor prisene hentes «dyrt»

Den opplagte løsningen er `POST /products/prices-bulk`: 100 strekkoder i ett
kall. Vi brukte den først, og den er feil. Målt på samme vare
(Lettmelk Q 1,75 l, EAN 7048840081950):

| Endepunkt | Kjeder | Billigste funnet |
|---|---|---|
| `prices-bulk` | 2 — Spar, Meny | 31,90 |
| `/products/ean/{ean}` | 6 — inkl. **Kiwi 28,80**, Coop 29,50 | **28,80** |

Bulk utelot Kiwi, som var billigst. En app som sender deg til Meny for 31,90 når
Kiwi har 28,80 gjør det motsatte av jobben sin. Derfor ett kall per strekkode,
med 1,1 sekunds mellomrom for å holde rate-limiten — og derfor en
bakgrunnsfunksjon, som har 15 minutter i stedet for 30 sekunder.

Bulk beholdes til én ting: **dypere prishistorikk**. Per-EAN gir 25 punkter
spredt over produktets levetid, bulk gir tette daglige punkter for de kjedene
den dekker. Det er historikken tilbud-merkene bygger på.

### Filene som betyr noe

| Fil | Ansvar |
|---|---|
| `public/js/optimizer.js` | All prisregning. Rene funksjoner, ingen nettverk. Testet i `test/optimizer.test.js` |
| `netlify/lib/kassal.mjs` | Kø og backoff mot Kassalapp, så vi aldri bryter 60/min |
| `netlify/lib/pricematrix.mjs` | Bygger prismatrisen: ett kall per strekkode, pluss bulk til historikk |
| `netlify/lib/chains.mjs` | Oversetter butikkoder til priskoder. Coop trenger dette — se under |
| `netlify/functions/refresh-run.mjs` | Bakgrunnsfunksjonen som gjør den tunge jobben |
| `netlify/functions/discover.mjs` | Leter etter nye produkter, 15 varer per kjøring |
| `scripts/smoke.mjs` | Røyktest mot ekte API. Denne fanger det enhetstestene ikke kan |

### To kodesett for Coop

Kassalapp merker alle Coop-**priser** med `COOP_NO`, men Coop-**butikker** med
`COOP_EXTRA`, `COOP_PRIX`, `COOP_MEGA`, `COOP_OBS` og `COOP_MARKED`. Målt:
`store=COOP_EXTRA` gir 0 produkter, `store=COOP_NO` gir 100.

Det betyr noe her: av de 100 butikkene innenfor 12 km av Kristiansand sentrum er
**42 Coop**. Uten oversettelsen i `chains.mjs` forsvinner byens største
kjedetilstedeværelse helt ut av sammenligningen.

### Erstatninger — hvorfor en vare ikke er en strekkode

En linje på handlelista er et *begrep*, ikke en fast liste strekkoder. Alle
butikker selger toalettpapir, bare ikke akkurat det merket du krysset av: Kiwi
har First Price, Rema har Prima, Coop har X-tra. Låser vi varen til noen få
strekkoder, blir den «mangler» i halve utvalget, og butikken rangeres ned av en
grunn som ikke har med pris å gjøre.

Rekkefølgen per vare og kjede er derfor:

1. **Godkjent strekkode** — har kjeden en av dine, brukes den
2. **Erstatning** — ellers billigste vare i samme kategori, merket i planen
3. **Mangler** — først da, og det blir sjeldent

To filtre avgjør hva som er en gyldig erstatning, og begge er nødvendige:

| Filter | Uten det |
|---|---|
| **Ordgrense** | «cola» traff «ruc**cola**» og «cho**cola**te», fordi Kassalapp søker på delstreng |
| **Samme kategori** | «gulost» traff «Lesgards Marmelade til Gulost», som er syltetøy |

Kategorien hentes fra produktene du selv har godkjent — ikke fra en liste vi har
funnet på.

**Det tredje utfallet.** Kjedene bruker ulike kategoritrær, så et hardt
kategorifilter gir falske negative: Rema forsvant helt fra toalettpapir, enda de
hadde den billigste varen av alle. Derfor droppes ingen butikk stille. Treff som
matcher ordet men ikke kategorien går til **«Nytt»-innboksen** som et forslag du
svarer ja eller nei på én gang. Sier du ja, blir det en godkjent vare for godt.

Erstatning er på som standard. Slå den av per vare, eller trykk **Lås** på et
godkjent produkt for varer der bare det ene duger — kaffen din, for eksempel.

### Tilbud-merkene

Kassalapp har ikke noe tilbud-endepunkt, så merkene regnes ut fra varens egen
prishistorikk i den kjeden:

| Merke | Betyr |
|---|---|
| **Tilbud −25 %** | Minst 15 % under medianen siste 60 dager |
| **Laveste på N d** | Lavere enn noe vi har registrert, og under medianen. `N` er hvor langt historikken faktisk rekker — mellom 25 og 90 dager |
| **Dyrt nå** | Minst 5 % over medianen — vent hvis du kan |
| *(ingen merke)* | Normalpris, eller for lite fersk historikk til å si noe |

Median, ikke gjennomsnitt: én rar dag i historikken skal ikke flytte hva vi
kaller normalpris. En vare som «settes ned» til sin egen normalpris får ikke
tilbud-merke — det er hele poenget.

Perioden står i merket og er ikke pyntet på. Kassalapp gir ikke like dyp
historikk for alle kjeder, og et merke som påsto «90 dager» når vi hadde 24 ville
vært en påstand vi ikke kan dekke.

### Produktbildene

Bildene kommer fra Kassalapp (`bilder.ngdata.no`, `cdcimg.coop.no`,
`bilder.kolonial.no`, `images.oda.com`). Dekningen var 100 % i utvalget vi
målte. De lagres **per strekkode og per kjede** i prismatrisen, så når
optimalisereren bytter til et annet produkt — for eksempel fordi et
First Price-alternativ ble billigst — følger bildet automatisk med. Det krever
ingen egen logikk; det faller ut av at alt er nøklet på strekkode.

---

## Ærlige begrensninger

- **Norske kjeder priser nasjonalt.** «Billigst i Kristiansand» betyr i praksis
  «billigst blant kjedene som har butikk nær deg». Lokale Coop-samvirkelag og
  Obs-varehus kan avvike fra kjedeprisen.
- **Erstatninger er sammenlignbare, ikke identiske.** «Toalettpapir» hos
  Meny til 14,60 og hos Rema til 20,00 er ikke nødvendigvis samme kvalitet
  eller antall ark. Appen viser alltid hvilket produkt som ble valgt, og kr/kg
  der vi har det, så du kan se om byttet er reelt.
- **Prisene hentes én gang i døgnet og kan være feil.** Dette er
  beslutningsstøtte, ikke en garanti i kassa.
- **Coop-prisene skiller ikke mellom butikkformatene.** Kassalapp har ett
  prissett for Extra, Prix, Mega og Obs, som i virkeligheten har ulike priser.
  Appen sier fra om dette i planen.
- **Tilbud-merkene dukker bare opp der historikken er fersk nok.** I vår måling
  hadde omtrent halvparten av kjede-seriene nok daglige datapunkter. De øvrige
  får ikke merke i stedet for å få et gjettet merke.
- **Rema 1000 har tynn dekning i Kassalapp.** De har 14 butikker i Kristiansand,
  men få priser i datagrunnlaget. Rema kan derfor havne nederst i rangeringen
  fordi vi mangler data, ikke fordi de er dyre. Kolonnen «Dekker» viser dette.
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
