/**
 * Optimalisereren — hjertet i Corbis.
 *
 * Rene funksjoner: data inn, data ut. Ingen nettverk, ingen DOM, ingen
 * globale variabler. Derfor kan den kjøres både i nettleseren og i
 * node --test, og derfor kan vi stole på tallene den gir.
 *
 * Alle beløp rundes til to desimaler før de forlater en funksjon. Uten det
 * ville flyttallsregning gi totaler som "304.65000000000003".
 */

// ---------------------------------------------------------------------------
// Enheter
// ---------------------------------------------------------------------------

/**
 * Enhetene Kassalapp bruker, gruppert i familier. Vi sammenligner aldri på
 * tvers av familier — en pris per kilo og en pris per liter er ikke samme
 * størrelse, og å gjette ville gitt et tall som ser riktig ut men er feil.
 *
 * `divisor` regner om til familiens grunnenhet (kg, liter, stk, meter, m²).
 * Vi deler i stedet for å gange, fordi 400 / 1000 er eksakt i flyttall
 * mens 400 * 0.001 ikke alltid er det.
 */
const UNITS = {
  g: { family: "masse", divisor: 1000 },
  hg: { family: "masse", divisor: 10 },
  kg: { family: "masse", divisor: 1 },

  ml: { family: "volum", divisor: 1000 },
  cl: { family: "volum", divisor: 100 },
  dl: { family: "volum", divisor: 10 },
  l: { family: "volum", divisor: 1 },

  stk: { family: "antall", divisor: 1 },
  piece: { family: "antall", divisor: 1 },
  pair: { family: "antall", divisor: 1 },
  portion: { family: "antall", divisor: 1 },
  dosage: { family: "antall", divisor: 1 },

  cm: { family: "lengde", divisor: 100 },
  m: { family: "lengde", divisor: 1 },
  m100: { family: "lengde", divisor: 0.01 },

  squaremeter: { family: "areal", divisor: 1 },
};

/**
 * Regner en mengde om til familiens grunnenhet.
 * Returnerer null for ukjente enheter — bevisst, slik at kalleren må ta
 * stilling til det i stedet for å få et gjettet tall.
 */
export function toBase(qty, unit) {
  const key = String(unit ?? "").toLowerCase();
  const u = UNITS[key];
  const n = Number(qty);
  if (!u || !Number.isFinite(n)) return null;
  return { amount: n / u.divisor, family: u.family };
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Et positivt tall, eller null.
 *
 * Finnes fordi Number(null) er 0 og ikke NaN. Et manglende felt fra API-et ble
 * dermed til prisen 0 kr, Number.isFinite(0) sa ja, og butikken med minst data
 * vant hver eneste sammenligning med gratis varer. Ingen pris, ingen vekt og
 * ingen kilopris er noen gang lovlig null i praksis, så vi krever > 0.
 */
export function positiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Statistikk
// ---------------------------------------------------------------------------

/** Median. Tom liste gir null, ikke NaN. */
export function median(nums) {
  const xs = (nums ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Under dette antall datapunkter later vi ikke som vi vet hva som er normalpris. */
const MIN_HISTORY_POINTS = 5;

/** Hvor langt tilbake vi regner normalpris fra. */
export const HISTORY_WINDOW_DAYS = 60;

/** Antall datapunkter innenfor vinduet — altså hvor mye ferskt vi har. */
export function recentPointCount(points, now = Date.now(), windowDays = HISTORY_WINDOW_DAYS) {
  const cutoff = (now instanceof Date ? now.getTime() : now) - windowDays * 86_400_000;
  let n = 0;
  for (const p of points ?? []) {
    const t = Date.parse(p?.date);
    if (Number.isFinite(t) && t >= cutoff) n++;
  }
  return n;
}

/**
 * Velger den mest brukbare av to prishistorikker.
 *
 * Fersk slår lang, og det er ikke åpenbart. /products/ean/ gir 25 punkter,
 * men de er en stikkprøve spredt over produktets hele levetid — Kiwis
 * kyllinghistorikk kom fra april 2023. /products/prices-bulk gir tettere og
 * ferskere data for de kjedene den dekker. En regel som bare teller punkter
 * ville valgt de gamle, og da blir hvert tilbud-merke UKJENT.
 */
export function pickBetterHistory(a, b, now = Date.now()) {
  const ra = recentPointCount(a, now);
  const rb = recentPointCount(b, now);
  if (ra !== rb) return ra > rb ? a : b;
  return (a?.length ?? 0) >= (b?.length ?? 0) ? a : b;
}

export const BADGE = {
  UKJENT: "UKJENT",
  TILBUD: "TILBUD",
  // Bevisst uten tall i navnet. Hvor langt tilbake vi faktisk ser varierer:
  // per-EAN-endepunktet gir rundt 25 dager, bulk-endepunktet opptil 90. Å kalle
  // merket LAVESTE_90D ville vært en påstand vi ikke alltid kan dekke, så
  // perioden følger med som `spanDays` og settes inn i teksten av UI-et.
  LAVESTE: "LAVESTE",
  DYRT_NA: "DYRT_NA",
  NORMAL: "NORMAL",
};

/**
 * Vurderer dagens pris mot varens egen historikk i samme kjede.
 *
 * Vi bruker median, ikke gjennomsnitt: én rar dag i historikken skal ikke
 * flytte hva vi kaller normalpris.
 *
 * Rekkefølge: er prisen både lavere enn alt vi har sett og under medianen,
 * er "laveste på 90 dager" den sterkeste og mest handlingsrettede beskjeden,
 * så den vinner over "tilbud".
 */
export function badgeFor(history, currentPrice, opts = {}) {
  const {
    now = new Date(),
    windowDays = 60,
    tilbudFactor = 0.85,
    dyrtFactor = 1.05,
  } = opts;

  const current = Number(currentPrice);
  const rows = Array.isArray(history) ? history : [];
  const cutoff = now.getTime() - windowDays * 86_400_000;

  const windowPrices = rows
    .filter((r) => {
      const t = Date.parse(r?.date);
      return Number.isFinite(t) && t >= cutoff;
    })
    .map((r) => positiveNumber(r.price))
    .filter((n) => n !== null);

  const empty = {
    badge: BADGE.UKJENT,
    medianPrice: null,
    pctVsMedian: null,
    isLowest: false,
    spanDays: 0,
    points: windowPrices.length,
  };

  if (!Number.isFinite(current) || windowPrices.length < MIN_HISTORY_POINTS) return empty;

  const med = median(windowPrices);
  if (med === null || med <= 0) return empty;

  // "Laveste" måles mot alt vi har, ikke bare vinduet — og da må vi kunne si
  // hvor langt tilbake det faktisk rekker.
  const stamps = rows
    .map((r) => Date.parse(r?.date))
    .filter((t) => Number.isFinite(t));
  const spanDays = stamps.length
    ? Math.max(1, Math.round((Math.max(...stamps) - Math.min(...stamps)) / 86_400_000))
    : 0;

  const allPrices = rows.map((r) => positiveNumber(r.price)).filter((n) => n !== null);
  const lowestSeen = allPrices.length ? Math.min(...allPrices) : null;

  const isLowest = lowestSeen !== null && current <= lowestSeen && current < med;
  const pctVsMedian = Math.round((current / med - 1) * 100);

  let badge = BADGE.NORMAL;
  if (isLowest) badge = BADGE.LAVESTE;
  else if (current <= med * tilbudFactor) badge = BADGE.TILBUD;
  else if (current >= med * dyrtFactor) badge = BADGE.DYRT_NA;

  return {
    badge,
    medianPrice: round2(med),
    pctVsMedian,
    isLowest,
    spanDays,
    points: windowPrices.length,
  };
}

// ---------------------------------------------------------------------------
// Prismatrisen
// ---------------------------------------------------------------------------

/**
 * Hva én pakke koster deg, gitt hvordan varen skal sammenlignes.
 *
 * compareBy "pack": pakkepris × antall. Enkelt — du vil ha tre pakker.
 * compareBy "unit": pris per kilo/liter × mengden du trenger. Da lures du
 *   ikke av at Meny selger 900 g og Kiwi 400 g.
 *
 * Returnerer null når vi ikke kan sammenligne ærlig.
 */
function costFor(item, entry, storeRow) {
  const qty = positiveNumber(item.qty) ?? 1;
  const pack = positiveNumber(storeRow?.price);
  if (pack === null) return null;

  if ((item.compareBy ?? "unit") === "pack") {
    return { cost: round2(pack * qty), perBase: null, basis: "pack" };
  }

  const want = toBase(qty, item.qtyUnit);
  if (!want) return null;

  let perBase = null;

  // Førstevalg: kilopris rett fra API-et. Den mangler ofte — særlig hos Kiwi
  // og Coop — og da må vi regne den ut selv, ikke behandle den som null kroner.
  const up = positiveNumber(storeRow.unitPrice);
  if (up !== null && storeRow.unitPriceUnit) {
    const one = toBase(1, storeRow.unitPriceUnit);
    if (one && one.family === want.family && one.amount > 0) perBase = up / one.amount;
  }

  // Reserve: regn den ut fra pakkevekten.
  if (perBase === null) {
    const w = toBase(positiveNumber(entry?.weight), entry?.weightUnit);
    if (w && w.family === want.family && w.amount > 0) perBase = pack / w.amount;
  }

  if (perBase === null || !Number.isFinite(perBase) || perBase <= 0) return null;

  return { cost: round2(perBase * want.amount), perBase: round2(perBase), basis: "unit" };
}

/**
 * Bygger prismatrisen: for hver vare på lista, hva den koster i hver kjede.
 *
 * Resultat: matrix[itemId][chain] = celle, der celle.status er
 *   "ok"           — vi har en pris vi kan stole på
 *   "missing"      — kjeden har ingen av de godkjente strekkodene
 *   "incomparable" — kjeden har varen, men vi kan ikke regne en ærlig pris
 *                    (ukjent enhet, eller enheter som ikke kan sammenlignes)
 *
 * "missing" skal vises i UI-et, ikke skjules. En butikk som mangler kaffen
 * din er ikke billigere — den er ubrukelig for den turen.
 */
export function buildMatrix({ items, prices, chains, now = new Date() }) {
  const byEan = prices?.byEan ?? {};
  const matrix = {};

  for (const item of items ?? []) {
    const row = {};
    const candidates = item.lockedEan ? [item.lockedEan] : (item.approvedEans ?? []);

    for (const chain of chains ?? []) {
      let best = null;
      let sawChainButCannotCompare = false;

      for (const ean of candidates) {
        const entry = byEan[ean];
        const storeRow = entry?.stores?.[chain];
        if (!storeRow) continue;

        const priced = costFor(item, entry, storeRow);
        if (!priced) {
          sawChainButCannotCompare = true;
          continue;
        }

        if (!best || priced.cost < best.cost) {
          const verdict = badgeFor(entry.history?.[chain], Number(storeRow.price), { now });
          best = {
            status: "ok",
            ean,
            name: entry.name ?? null,
            packPrice: round2(Number(storeRow.price)),
            unitPrice: priced.perBase,
            weight: entry.weight ?? null,
            weightUnit: entry.weightUnit ?? null,
            // Bildet følger kjeden først, varen som reserve. Når
            // optimalisereren bytter til et annet produkt eller en annen
            // kjede, bytter bildet seg selv — alt er nøklet på strekkode.
            image: storeRow.image ?? entry.image ?? null,
            url: storeRow.url ?? null,
            cost: priced.cost,
            basis: priced.basis,
            ...verdict,
          };
        }
      }

      // Ingen godkjent strekkode i denne kjeden? Bruk en erstatning fra samme
      // kategori. «Toalettpapir» finnes i alle butikker — bare ikke akkurat
      // det merket du krysset av. Å kalle det «mangler» ville rangert butikken
      // ned av en grunn som ikke har med pris å gjøre.
      if (!best && !item.lockedEan) {
        const sub = prices?.substitutes?.[item.id]?.[chain];
        if (sub) {
          const entry = {
            name: sub.name,
            weight: sub.weight,
            weightUnit: sub.weightUnit,
            image: sub.image,
          };
          const storeRow = {
            price: sub.price,
            unitPrice: sub.unitPrice,
            unitPriceUnit: sub.unitPriceUnit,
            image: sub.image,
            url: sub.url,
          };
          const priced = costFor(item, entry, storeRow);
          if (priced) {
            best = {
              status: "ok",
              substitute: true,
              ean: sub.ean,
              name: sub.name ?? null,
              categoryPath: sub.categoryPath ?? null,
              packPrice: round2(sub.price),
              unitPrice: priced.perBase,
              weight: sub.weight ?? null,
              weightUnit: sub.weightUnit ?? null,
              image: sub.image ?? null,
              url: sub.url ?? null,
              cost: priced.cost,
              basis: priced.basis,
              // Erstatninger har ingen prishistorikk hos oss, så vi gir dem
              // heller ikke et tilbud-merke vi ikke kan stå for.
              ...badgeFor(null, sub.price, { now }),
            };
          } else {
            sawChainButCannotCompare = true;
          }
        }
      }

      if (best) row[chain] = best;
      else if (sawChainButCannotCompare) {
        row[chain] = {
          status: "incomparable",
          reason: "Kan ikke sammenlignes — mangler vekt eller enheten passer ikke.",
        };
      } else {
        row[chain] = { status: "missing" };
      }
    }

    matrix[item.id] = row;
  }

  return matrix;
}

// ---------------------------------------------------------------------------
// Rangering
// ---------------------------------------------------------------------------

/** Alle kombinasjoner av k elementer, i samme rekkefølge som inn-lista. */
export function combinations(arr, k) {
  const out = [];
  const list = arr ?? [];
  if (k <= 0 || k > list.length) return out;

  const walk = (start, picked) => {
    if (picked.length === k) {
      out.push(picked.slice());
      return;
    }
    for (let i = start; i < list.length; i++) {
      picked.push(list[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

/**
 * Sorteringsregelen for både enkeltbutikker og kombinasjoner:
 * dekning først, deretter pris.
 *
 * Dette er et bevisst valg. En restevarebutikk som bare har kaffen din til
 * 10 kr vil ellers troppe lista med "10 kr" og se ut som vinneren, mens den
 * i praksis mangler 24 av 25 varer. Dekning først gjør rangeringen ærlig.
 */
function byCoverageThenPrice(a, b) {
  return b.covered - a.covered || a.total - b.total;
}

export function rankSingle({ matrix, items, chains }) {
  return (chains ?? [])
    .map((chain) => {
      let total = 0;
      const perItem = {};
      const missing = [];
      const incomparable = [];

      for (const item of items ?? []) {
        const cell = matrix?.[item.id]?.[chain];
        if (!cell || cell.status === "missing") {
          missing.push(item.id);
          continue;
        }
        if (cell.status === "incomparable") {
          incomparable.push(item.id);
          continue;
        }
        total += cell.cost;
        perItem[item.id] = { chain, cost: cell.cost, ean: cell.ean, badge: cell.badge };
      }

      return {
        chain,
        chains: [chain],
        total: round2(total),
        covered: Object.keys(perItem).length,
        missing,
        incomparable,
        perItem,
      };
    })
    .sort((a, b) => byCoverageThenPrice(a, b) || a.chain.localeCompare(b.chain));
}

export function rankCombos({ matrix, items, chains, k }) {
  return combinations(chains, k)
    .map((combo) => {
      let total = 0;
      const perItem = {};
      const missing = [];
      const incomparable = [];

      for (const item of items ?? []) {
        let best = null;
        let sawIncomparable = false;

        for (const chain of combo) {
          const cell = matrix?.[item.id]?.[chain];
          if (!cell) continue;
          if (cell.status === "incomparable") {
            sawIncomparable = true;
            continue;
          }
          if (cell.status !== "ok") continue;
          if (!best || cell.cost < best.cost) {
            best = { chain, cost: cell.cost, ean: cell.ean, badge: cell.badge };
          }
        }

        if (best) {
          total += best.cost;
          perItem[item.id] = best;
        } else if (sawIncomparable) {
          incomparable.push(item.id);
        } else {
          missing.push(item.id);
        }
      }

      // Butikkene planen faktisk sender deg til. En kombinasjon av tre kjeder
      // der bare to har billigste vare er i praksis en tur til to butikker.
      const usedChains = [...new Set(Object.values(perItem).map((p) => p.chain))];

      return {
        chains: combo,
        usedChains,
        total: round2(total),
        covered: Object.keys(perItem).length,
        missing,
        incomparable,
        perItem,
      };
    })
    .sort(byCoverageThenPrice);
}

// ---------------------------------------------------------------------------
// Anbefalingen
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = { minSavingsPerStop: 40, maxStops: 3, maxKm: 12 };

/**
 * Bygger den anbefalte handleplanen.
 *
 * Vi legger til én butikk om gangen, og hver ekstra stopp må tjene seg inn:
 * enten ved å dekke varer ingen av de andre butikkene har, eller ved å spare
 * mer enn minSavingsPerStop kroner. Sparer den andre stoppen 12 kr, får du
 * beskjed om å handle alt på ett sted.
 *
 * Butikker lenger unna enn maxKm er ute før vi begynner å regne — det er
 * ingen vits i å foreslå en tur til Lyngdal for å spare 30 kr.
 */
export function recommend({
  items,
  prices,
  chains,
  settings,
  distanceByChain = {},
  now = new Date(),
}) {
  const s = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const excludedByDistance = [];

  const usable = (chains ?? []).filter((chain) => {
    const km = Number(distanceByChain[chain]);
    // Ukjent avstand betyr som regel nettbutikk (Oda). Du har valgt den
    // selv, så vi lar den stå.
    if (!Number.isFinite(km)) return true;
    if (km > s.maxKm) {
      excludedByDistance.push(chain);
      return false;
    }
    return true;
  });

  const emptyResult = {
    plan: null,
    singles: [],
    steps: [],
    matrix: {},
    extras: [],
    excludedByDistance,
    builtAt: prices?.builtAt ?? null,
    settings: s,
  };

  if (!items?.length || !usable.length) return emptyResult;

  const matrix = buildMatrix({ items, prices, chains: usable, now });
  const singles = rankSingle({ matrix, items, chains: usable });

  let plan = singles[0] ?? null;
  const steps = plan
    ? [{ stops: 1, total: plan.total, covered: plan.covered, chains: plan.chains }]
    : [];

  const maxK = Math.min(Math.max(1, Math.trunc(s.maxStops) || 1), usable.length);

  for (let k = 2; k <= maxK; k++) {
    const best = rankCombos({ matrix, items, chains: usable, k })[0];
    if (!best) break;

    steps.push({ stops: k, total: best.total, covered: best.covered, chains: best.usedChains });

    const coversMore = best.covered > plan.covered;
    const savesEnough =
      best.covered === plan.covered && best.total <= round2(plan.total - s.minSavingsPerStop);

    if (coversMore || savesEnough) plan = best;
    else break;
  }

  if (plan) {
    // Rapporter butikkene planen faktisk bruker, ikke kombinasjonen vi testet.
    plan = { ...plan, chains: plan.usedChains?.length ? plan.usedChains : plan.chains };
  }

  const bestSingleTotal = singles[0]?.total ?? null;
  const savingsVsBestSingle =
    plan && bestSingleTotal !== null ? round2(bestSingleTotal - plan.total) : 0;

  return {
    plan,
    singles,
    steps,
    matrix,
    extras: plan ? extraCostPerItem({ plan, matrix, items, chains: usable }) : [],
    savingsVsBestSingle,
    excludedByDistance,
    builtAt: prices?.builtAt ?? null,
    settings: s,
  };
}

/**
 * For hver vare: hva planen koster deg mot billigste pris blant alle valgte
 * butikker. Slik ser du hvor pengene forsvinner uten å måtte kjøre rundt.
 */
export function extraCostPerItem({ plan, matrix, items, chains }) {
  const out = [];

  for (const item of items ?? []) {
    const planned = plan?.perItem?.[item.id] ?? null;

    let cheapest = null;
    for (const chain of chains ?? []) {
      const cell = matrix?.[item.id]?.[chain];
      if (!cell || cell.status !== "ok") continue;
      if (!cheapest || cell.cost < cheapest.cost) cheapest = { chain, cost: cell.cost };
    }

    out.push({
      itemId: item.id,
      label: item.label ?? item.id,
      planChain: planned?.chain ?? null,
      planCost: planned?.cost ?? null,
      badge: planned?.badge ?? null,
      cheapestChain: cheapest?.chain ?? null,
      cheapestCost: cheapest?.cost ?? null,
      extra: planned && cheapest ? round2(planned.cost - cheapest.cost) : null,
      status: planned ? "ok" : matrix?.[item.id] ? "unavailable" : "unknown",
    });
  }

  return out.sort((a, b) => (b.extra ?? -1) - (a.extra ?? -1));
}

// ---------------------------------------------------------------------------
// Formatering (brukes av UI-et)
// ---------------------------------------------------------------------------

export function formatKr(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "–";
  return new Intl.NumberFormat("nb-NO", {
    style: "currency",
    currency: "NOK",
    maximumFractionDigits: 2,
  }).format(Number(n));
}

export function formatUnitPrice(perBase, qtyUnit) {
  if (!Number.isFinite(Number(perBase))) return null;
  const base = UNITS[String(qtyUnit ?? "").toLowerCase()]?.family;
  const label = base === "volum" ? "kr/l" : base === "antall" ? "kr/stk" : "kr/kg";
  return `${new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 }).format(Number(perBase))} ${label}`;
}
