/**
 * Tester for optimalisereren.
 *
 * Dette er den delen av appen der en feil koster deg penger i virkeligheten:
 * feil total betyr at du kjører til feil butikk. Derfor er den ren logikk
 * uten nettverk eller DOM, og derfor testes den her.
 *
 * Kjør med:  npm test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  median,
  toBase,
  positiveNumber,
  pickBetterHistory,
  recentPointCount,
  badgeFor,
  combinations,
  buildMatrix,
  rankSingle,
  rankCombos,
  recommend,
  extraCostPerItem,
} from "../public/js/optimizer.js";

// ---------------------------------------------------------------------------
// Testdata
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-17T09:00:00Z");

/**
 * Lager prishistorikk: `days` dager med fast pris, som slutter `endDaysAgo`
 * dager før NOW. Slik kan vi sette sammen realistiske forløp, f.eks.
 * "billig i to uker i vår, normalpris siden".
 */
function flatHistory(price, days, endDaysAgo = 0) {
  const out = [];
  for (let i = days - 1 + endDaysAgo; i >= endDaysAgo; i--) {
    const d = new Date(NOW.getTime() - i * 86_400_000);
    out.push({ date: d.toISOString().slice(0, 10), price });
  }
  return out;
}

/** Var billig en periode i vår, normalpris siden. Gir TILBUD, ikke bunnrekord. */
const historikkMedTidligereBunn = (bunn, normal) => [
  ...flatHistory(bunn, 15, 45),
  ...flatHistory(normal, 45),
];

/**
 * Kyllingfilet i to pakningsstørrelser, for å bevise at kr/kg-sammenligningen
 * ikke lures av at Meny selger en større pakke.
 */
const PRICES = {
  builtAt: NOW.toISOString(),
  byEan: {
    // 400 g hos Kiwi: 89,90 kr => 224,75 kr/kg. Normalpris 119,90.
    "111": {
      name: "Kyllingfilet 400 g",
      weight: 400,
      weightUnit: "g",
      stores: {
        KIWI: { price: 89.9, unitPrice: 224.75, unitPriceUnit: "kg" },
        REMA_1000: { price: 99.9, unitPrice: 249.75, unitPriceUnit: "kg" },
      },
      history: {
        KIWI: historikkMedTidligereBunn(84.9, 119.9),
        REMA_1000: flatHistory(99.9, 60),
      },
    },
    // 900 g hos Meny: 449 kr => 498,89 kr/kg. Billig per pakke, dyr per kilo.
    "222": {
      name: "Kyllingfilet 900 g",
      weight: 900,
      weightUnit: "g",
      stores: {
        MENY_NO: { price: 449, unitPrice: 498.89, unitPriceUnit: "kg" },
      },
      history: { MENY_NO: flatHistory(449, 60) },
    },
    // Kaffe, finnes i alle tre. Rema billigst.
    "333": {
      name: "Kaffe 500 g",
      weight: 500,
      weightUnit: "g",
      stores: {
        KIWI: { price: 79.9, unitPrice: 159.8, unitPriceUnit: "kg" },
        REMA_1000: { price: 59.9, unitPrice: 119.8, unitPriceUnit: "kg" },
        MENY_NO: { price: 89.9, unitPrice: 179.8, unitPriceUnit: "kg" },
      },
      history: {
        KIWI: flatHistory(79.9, 60),
        REMA_1000: [...flatHistory(54.9, 10, 50), ...flatHistory(79.9, 50)],
        MENY_NO: flatHistory(89.9, 60),
      },
    },
    // Spesialvare som bare Meny har.
    "444": {
      name: "Fetaost 200 g",
      weight: 200,
      weightUnit: "g",
      stores: { MENY_NO: { price: 39.9, unitPrice: 199.5, unitPriceUnit: "kg" } },
      history: { MENY_NO: flatHistory(39.9, 60) },
    },
  },
};

const ITEMS = [
  {
    id: "kylling",
    label: "Kyllingfilet",
    qty: 1,
    qtyUnit: "kg",
    compareBy: "unit",
    approvedEans: ["111", "222"],
  },
  {
    id: "kaffe",
    label: "Kaffe",
    qty: 1,
    qtyUnit: "stk",
    compareBy: "pack",
    approvedEans: ["333"],
  },
];

const CHAINS = ["KIWI", "REMA_1000", "MENY_NO"];

// Kiwi alene: 224,75 + 79,90 = 304,65
// Kiwi + Rema:  224,75 + 59,90 = 284,65
const TOTAL_KIWI_ALENE = 304.65;
const TOTAL_KIWI_PLUSS_REMA = 284.65;

// ---------------------------------------------------------------------------

describe("median", () => {
  test("oddetall antall gir midtverdien", () => {
    assert.equal(median([3, 1, 2]), 2);
  });

  test("partall antall gir snittet av de to midterste", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  test("tom liste gir null, ikke NaN", () => {
    assert.equal(median([]), null);
  });

  test("medianen lar seg ikke flytte av én rar dag", () => {
    // Gjennomsnittet ville blitt 120. Medianen holder seg der prisen faktisk er.
    assert.equal(median([39, 40, 41, 400]), 40.5);
  });
});

describe("positiveNumber", () => {
  test("null blir null, ikke 0", () => {
    // Number(null) er 0. Denne feilen gjorde at varer uten kilopris ble
    // regnet som gratis, og butikken med minst data vant alt.
    assert.equal(positiveNumber(null), null);
    assert.equal(positiveNumber(undefined), null);
    assert.equal(positiveNumber(""), null);
  });

  test("null og negative tall avvises", () => {
    assert.equal(positiveNumber(0), null);
    assert.equal(positiveNumber(-5), null);
  });

  test("tall og tallstrenger slipper gjennom", () => {
    assert.equal(positiveNumber(29.9), 29.9);
    assert.equal(positiveNumber("99.00"), 99);
  });
});

describe("manglende kilopris fører aldri til gratis varer", () => {
  // Regresjonstest for feilen som gjorde at Kiwi «vant» med kylling til 0 kr.
  const PRICES_UTEN_UNITPRICE = {
    builtAt: NOW.toISOString(),
    byEan: {
      "800": {
        name: "Kyllingfilet 2 kg First Price",
        weight: 2000,
        weightUnit: "g",
        stores: {
          // Kiwi oppgir ikke kilopris — dette er det vanlige tilfellet.
          KIWI: { price: 279, unitPrice: null, unitPriceUnit: "kg" },
          MENY_NO: { price: 299, unitPrice: 149.5, unitPriceUnit: "kg" },
        },
        history: {},
      },
    },
  };

  const item = {
    id: "kylling", label: "Kyllingfilet", qty: 1, qtyUnit: "kg",
    compareBy: "unit", approvedEans: ["800"],
  };

  const matrix = buildMatrix({
    items: [item], prices: PRICES_UTEN_UNITPRICE, chains: ["KIWI", "MENY_NO"], now: NOW,
  });

  test("kiloprisen regnes ut fra vekten når API-et ikke oppgir den", () => {
    assert.equal(matrix.kylling.KIWI.status, "ok");
    assert.equal(matrix.kylling.KIWI.cost, 139.5); // 279 kr / 2 kg
  });

  test("ingen celle koster 0 kr", () => {
    for (const chain of ["KIWI", "MENY_NO"]) {
      assert.ok(matrix.kylling[chain].cost > 0, `${chain} fikk kostnad 0`);
    }
  });

  test("Kiwi er faktisk billigst her, og av riktig grunn", () => {
    assert.ok(matrix.kylling.KIWI.cost < matrix.kylling.MENY_NO.cost);
    assert.equal(matrix.kylling.MENY_NO.cost, 149.5);
  });
});

describe("pickBetterHistory", () => {
  // Regresjonstest for at tilbud-merkene faktisk kan vises. /products/ean/ gir
  // 25 punkter spredt over flere år; bulk gir tettere og ferskere data. En
  // regel som bare teller punkter velger de gamle, og da blir alt UKJENT.
  const gammelOgLang = flatHistory(50, 25, 700); // 25 punkter, ~2 år siden
  const nyOgKort = flatHistory(50, 8); // 8 punkter, siste uke

  test("fersk historikk slår lang historikk", () => {
    assert.equal(pickBetterHistory(gammelOgLang, nyOgKort, NOW), nyOgKort);
    assert.equal(pickBetterHistory(nyOgKort, gammelOgLang, NOW), nyOgKort);
  });

  test("er begge ferske, vinner den lengste", () => {
    const lang = flatHistory(50, 40);
    assert.equal(pickBetterHistory(nyOgKort, lang, NOW), lang);
  });

  test("er ingen ferske, vinner den lengste", () => {
    const kortOgGammel = flatHistory(50, 3, 700);
    assert.equal(pickBetterHistory(kortOgGammel, gammelOgLang, NOW), gammelOgLang);
  });

  test("recentPointCount teller bare innenfor vinduet", () => {
    assert.equal(recentPointCount(nyOgKort, NOW), 8);
    assert.equal(recentPointCount(gammelOgLang, NOW), 0);
    assert.equal(recentPointCount([], NOW), 0);
  });

  test("gammel historikk gir UKJENT, ikke et tall vi ikke kan stå for", () => {
    // Dette er hvorfor regelen betyr noe: uten fersk data skal vi ikke gjette.
    assert.equal(badgeFor(gammelOgLang, 30, { now: NOW }).badge, "UKJENT");
    assert.equal(badgeFor(nyOgKort, 30, { now: NOW }).badge, "LAVESTE");
  });
});

describe("toBase", () => {
  test("gram og kilo havner i samme familie", () => {
    assert.deepEqual(toBase(400, "g"), { amount: 0.4, family: "masse" });
    assert.deepEqual(toBase(1, "kg"), { amount: 1, family: "masse" });
  });

  test("desiliter og liter havner i samme familie", () => {
    assert.deepEqual(toBase(5, "dl"), { amount: 0.5, family: "volum" });
  });

  test("stk er sin egen familie", () => {
    assert.deepEqual(toBase(2, "stk"), { amount: 2, family: "antall" });
    assert.deepEqual(toBase(2, "piece"), { amount: 2, family: "antall" });
  });

  test("ukjent enhet gir null i stedet for et gjettet tall", () => {
    assert.equal(toBase(1, "klask"), null);
  });
});

describe("badgeFor", () => {
  test("25 % under medianen er TILBUD", () => {
    const r = badgeFor(historikkMedTidligereBunn(84.9, 119.9), 89.9, { now: NOW });
    assert.equal(r.badge, "TILBUD");
    assert.equal(r.pctVsMedian, -25);
    assert.equal(r.medianPrice, 119.9);
  });

  test("laveste registrerte pris vinner over TILBUD", () => {
    // Samme rabatt som over, men her har prisen aldri vært lavere.
    // Da er "laveste på N dager" den sterkeste beskjeden vi kan gi.
    const r = badgeFor(flatHistory(119.9, 60), 89.9, { now: NOW });
    assert.equal(r.badge, "LAVESTE");
    assert.equal(r.isLowest, true);
    assert.equal(r.pctVsMedian, -25);
  });

  test("flat pris er NORMAL, ikke LAVESTE", () => {
    // Uten kravet om at prisen også må ligge under medianen ville alt med
    // stabil pris fått laveste-merket, som er teknisk sant og ubrukelig.
    const r = badgeFor(flatHistory(39.9, 60), 39.9, { now: NOW });
    assert.equal(r.badge, "NORMAL");
    assert.equal(r.isLowest, false);
  });

  test("spanDays følger hvor langt historikken faktisk rekker", () => {
    // Merket skal aldri påstå 90 dager når vi bare har data for 24.
    // Per-EAN-endepunktet gir rundt 25 dager, bulk opptil 90.
    const kort = badgeFor(flatHistory(50, 25), 30, { now: NOW });
    assert.equal(kort.badge, "LAVESTE");
    assert.equal(kort.spanDays, 24);

    const lang = badgeFor(flatHistory(50, 60), 30, { now: NOW });
    assert.equal(lang.spanDays, 59);
  });

  test("over medianen er DYRT_NA", () => {
    const r = badgeFor(flatHistory(39.9, 60), 49.9, { now: NOW });
    assert.equal(r.badge, "DYRT_NA");
    assert.equal(r.pctVsMedian, 25);
  });

  test("uten historikk later vi ikke som vi vet noe", () => {
    assert.equal(badgeFor([], 49.9, { now: NOW }).badge, "UKJENT");
    assert.equal(badgeFor(null, 49.9, { now: NOW }).badge, "UKJENT");
  });

  test("for få datapunkter gir UKJENT", () => {
    assert.equal(badgeFor(flatHistory(50, 3), 30, { now: NOW }).badge, "UKJENT");
  });

  test("bare gamle datapunkter utenfor vinduet gir UKJENT", () => {
    const gammelt = flatHistory(100, 5, 80); // 80–84 dager siden
    assert.equal(badgeFor(gammelt, 50, { now: NOW }).badge, "UKJENT");
  });
});

describe("combinations", () => {
  test("alle par av tre elementer", () => {
    assert.deepEqual(combinations(["a", "b", "c"], 2), [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
  });

  test("k større enn lista gir ingenting", () => {
    assert.deepEqual(combinations(["a"], 2), []);
  });
});

describe("buildMatrix", () => {
  const matrix = buildMatrix({ items: ITEMS, prices: PRICES, chains: CHAINS, now: NOW });

  test("kr/kg brukes, ikke pakkepris, når compareBy er unit", () => {
    // Meny har bare 900 g-pakka til 449 kr. Per kilo er det 498,89 —
    // dyrere enn Kiwi, selv om Kiwi-pakka koster mindre i kroner.
    assert.equal(matrix.kylling.KIWI.status, "ok");
    assert.equal(matrix.kylling.KIWI.cost, 224.75);
    assert.equal(matrix.kylling.MENY_NO.cost, 498.89);
  });

  test("velger billigste godkjente strekkode i hver kjede", () => {
    assert.equal(matrix.kylling.KIWI.ean, "111");
  });

  test("pakkepris ganges med antall når compareBy er pack", () => {
    const toPakker = buildMatrix({
      items: [{ ...ITEMS[1], qty: 3 }],
      prices: PRICES,
      chains: CHAINS,
      now: NOW,
    });
    assert.equal(toPakker.kaffe.REMA_1000.cost, 179.7); // 59,90 × 3
  });

  test("vare som mangler i en kjede blir markert missing, ikke skjult", () => {
    const medFeta = buildMatrix({
      items: [
        ...ITEMS,
        { id: "feta", label: "Fetaost", qty: 1, qtyUnit: "stk", compareBy: "pack", approvedEans: ["444"] },
      ],
      prices: PRICES,
      chains: CHAINS,
      now: NOW,
    });
    assert.equal(medFeta.feta.KIWI.status, "missing");
    assert.equal(medFeta.feta.MENY_NO.status, "ok");
  });

  test("uforenlige enheter gir incomparable, ikke et gjettet tall", () => {
    const rart = buildMatrix({
      items: [{ id: "x", label: "Rar vare", qty: 1, qtyUnit: "l", compareBy: "unit", approvedEans: ["111"] }],
      prices: PRICES,
      chains: CHAINS,
      now: NOW,
    });
    // Varen prises per kilo, men vi ba om en liter.
    assert.equal(rart.x.KIWI.status, "incomparable");
  });

  test("lockedEan overstyrer approvedEans", () => {
    const laast = buildMatrix({
      items: [{ ...ITEMS[0], lockedEan: "222" }],
      prices: PRICES,
      chains: CHAINS,
      now: NOW,
    });
    assert.equal(laast.kylling.KIWI.status, "missing"); // Kiwi har ikke 900 g-pakka
    assert.equal(laast.kylling.MENY_NO.ean, "222");
  });

  test("tilbud-merket følger med i cellen", () => {
    assert.equal(matrix.kylling.KIWI.badge, "TILBUD");
    assert.equal(matrix.kaffe.REMA_1000.badge, "TILBUD");
    assert.equal(matrix.kaffe.MENY_NO.badge, "NORMAL");
  });

  test("mangler kr/kg fra API-et regner vi det ut fra vekten", () => {
    const utenUnitPrice = {
      builtAt: NOW.toISOString(),
      byEan: {
        "999": {
          name: "Ris 1 kg",
          weight: 1,
          weightUnit: "kg",
          stores: { KIWI: { price: 30 } }, // ingen unitPrice fra API-et
          history: {},
        },
      },
    };
    const m = buildMatrix({
      items: [{ id: "ris", label: "Ris", qty: 2, qtyUnit: "kg", compareBy: "unit", approvedEans: ["999"] }],
      prices: utenUnitPrice,
      chains: ["KIWI"],
      now: NOW,
    });
    assert.equal(m.ris.KIWI.cost, 60); // 30 kr/kg × 2 kg
  });
});

describe("erstatninger", () => {
  // Poenget: alle butikker selger dopapir, bare ikke akkurat det merket du
  // krysset av. Uten erstatning ble varen «mangler», og butikken rangerte ned
  // av en grunn som ikke har med pris å gjøre.
  const PRICES_MED_ERSTATNING = {
    builtAt: NOW.toISOString(),
    byEan: {
      "700": {
        name: "Toalettpapir Økonomi 8rl First Price",
        weight: 8,
        weightUnit: "stk",
        stores: { KIWI: { price: 18.9, unitPrice: null, unitPriceUnit: null } },
        history: {},
      },
    },
    substitutes: {
      dopapir: {
        REMA_1000: {
          ean: "701",
          name: "TOALETTPAPIR 8PK PRIMA",
          price: 20,
          unitPrice: null,
          unitPriceUnit: null,
          weight: 8,
          weightUnit: "stk",
          image: "https://example.test/prima.webp",
          categoryPath: null,
        },
      },
    },
  };

  const item = {
    id: "dopapir", label: "Toalettpapir", qty: 1, qtyUnit: "stk",
    compareBy: "pack", approvedEans: ["700"],
  };
  const chains = ["KIWI", "REMA_1000", "MENY_NO"];
  const matrix = buildMatrix({ items: [item], prices: PRICES_MED_ERSTATNING, chains, now: NOW });

  test("godkjent strekkode brukes der den finnes", () => {
    assert.equal(matrix.dopapir.KIWI.status, "ok");
    assert.equal(matrix.dopapir.KIWI.ean, "700");
    assert.ok(!matrix.dopapir.KIWI.substitute);
  });

  test("erstatning brukes der kjeden mangler godkjent produkt", () => {
    assert.equal(matrix.dopapir.REMA_1000.status, "ok");
    assert.equal(matrix.dopapir.REMA_1000.substitute, true);
    assert.equal(matrix.dopapir.REMA_1000.cost, 20);
    assert.equal(matrix.dopapir.REMA_1000.name, "TOALETTPAPIR 8PK PRIMA");
  });

  test("erstatningen har med bildet sitt", () => {
    assert.equal(matrix.dopapir.REMA_1000.image, "https://example.test/prima.webp");
  });

  test("erstatninger får ikke tilbud-merke de ikke har dekning for", () => {
    assert.equal(matrix.dopapir.REMA_1000.badge, "UKJENT");
  });

  test("kjede uten både godkjent og erstatning er fortsatt missing", () => {
    assert.equal(matrix.dopapir.MENY_NO.status, "missing");
  });

  test("en låst vare erstattes aldri", () => {
    const laast = buildMatrix({
      items: [{ ...item, lockedEan: "700" }],
      prices: PRICES_MED_ERSTATNING,
      chains,
      now: NOW,
    });
    assert.equal(laast.dopapir.REMA_1000.status, "missing");
  });

  test("erstatning teller som dekning i rangeringen", () => {
    const r = rankSingle({ matrix, items: [item], chains });
    const rema = r.find((x) => x.chain === "REMA_1000");
    assert.equal(rema.covered, 1);
    assert.deepEqual(rema.missing, []);
  });
});

describe("rankSingle", () => {
  const matrix = buildMatrix({ items: ITEMS, prices: PRICES, chains: CHAINS, now: NOW });
  const ranked = rankSingle({ matrix, items: ITEMS, chains: CHAINS });

  test("Kiwi vinner på kylling + kaffe", () => {
    assert.equal(ranked[0].chain, "KIWI");
    assert.equal(ranked[0].total, TOTAL_KIWI_ALENE);
  });

  test("full dekning rangeres foran lav total med hull", () => {
    // Holdbart har bare kaffe, til 10 kr. Total 10 er lavere enn alt annet,
    // men butikken dekker halve lista og skal derfor ikke troppe rangeringen.
    const pricesMedHoldbart = structuredClone(PRICES);
    pricesMedHoldbart.byEan["333"].stores.HOLDBART = { price: 10, unitPrice: 20, unitPriceUnit: "kg" };
    pricesMedHoldbart.byEan["333"].history.HOLDBART = flatHistory(10, 60);

    const chains = [...CHAINS, "HOLDBART"];
    const m = buildMatrix({ items: ITEMS, prices: pricesMedHoldbart, chains, now: NOW });
    const r = rankSingle({ matrix: m, items: ITEMS, chains });

    assert.equal(r[0].chain, "KIWI", "full dekning skal slå billig-med-hull");
    const holdbart = r.find((x) => x.chain === "HOLDBART");
    assert.equal(holdbart.covered, 1);
    assert.deepEqual(holdbart.missing, ["kylling"]);
  });
});

describe("rankCombos", () => {
  const matrix = buildMatrix({ items: ITEMS, prices: PRICES, chains: CHAINS, now: NOW });

  test("beste par plukker billigste vare fra hver butikk", () => {
    const pairs = rankCombos({ matrix, items: ITEMS, chains: CHAINS, k: 2 });
    // Kylling billigst på Kiwi (224,75), kaffe billigst på Rema (59,90).
    assert.deepEqual(pairs[0].chains.slice().sort(), ["KIWI", "REMA_1000"]);
    assert.equal(pairs[0].total, TOTAL_KIWI_PLUSS_REMA);
    assert.equal(pairs[0].perItem.kaffe.chain, "REMA_1000");
  });

  test("usedChains viser butikkene planen faktisk sender deg til", () => {
    // Meny er med i kombinasjonen, men er ikke billigst på noe.
    const triples = rankCombos({ matrix, items: ITEMS, chains: CHAINS, k: 3 });
    assert.deepEqual(triples[0].usedChains.slice().sort(), ["KIWI", "REMA_1000"]);
  });
});

describe("recommend", () => {
  const distances = { KIWI: 1.2, REMA_1000: 2.5, MENY_NO: 4.0 };

  test("foreslår to butikker når besparelsen er stor nok", () => {
    // Kiwi alene 304,65 → Kiwi + Rema 284,65. Sparer 20 kr, terskel er 15.
    const r = recommend({
      items: ITEMS,
      prices: PRICES,
      chains: CHAINS,
      settings: { minSavingsPerStop: 15, maxStops: 3, maxKm: 12 },
      distanceByChain: distances,
      now: NOW,
    });
    assert.equal(r.plan.chains.length, 2);
    assert.equal(r.plan.total, TOTAL_KIWI_PLUSS_REMA);
    assert.equal(r.savingsVsBestSingle, 20);
  });

  test("holder seg til én butikk når den andre stoppen ikke er verdt turen", () => {
    // Samme data, men nå må en ekstra stopp spare minst 50 kr.
    const r = recommend({
      items: ITEMS,
      prices: PRICES,
      chains: CHAINS,
      settings: { minSavingsPerStop: 50, maxStops: 3, maxKm: 12 },
      distanceByChain: distances,
      now: NOW,
    });
    assert.equal(r.plan.chains.length, 1);
    assert.equal(r.plan.chains[0], "KIWI");
    assert.equal(r.plan.total, TOTAL_KIWI_ALENE);
  });

  test("en ekstra stopp godtas alltid hvis den dekker varer ingen andre har", () => {
    // Fetaost finnes bare hos Meny. Da skal Meny med, uansett terskel.
    const items = [
      ...ITEMS,
      { id: "feta", label: "Fetaost", qty: 1, qtyUnit: "stk", compareBy: "pack", approvedEans: ["444"] },
    ];
    const r = recommend({
      items,
      prices: PRICES,
      chains: CHAINS,
      settings: { minSavingsPerStop: 9999, maxStops: 3, maxKm: 12 },
      distanceByChain: distances,
      now: NOW,
    });
    assert.ok(r.plan.chains.includes("MENY_NO"));
    assert.equal(r.plan.covered, 3);
  });

  test("butikk utenfor maxKm foreslås ikke, uansett hvor billig den er", () => {
    const pricesMedFjern = structuredClone(PRICES);
    pricesMedFjern.byEan["333"].stores.HOLDBART = { price: 5, unitPrice: 10, unitPriceUnit: "kg" };
    pricesMedFjern.byEan["333"].history.HOLDBART = flatHistory(5, 60);
    pricesMedFjern.byEan["111"].stores.HOLDBART = { price: 20, unitPrice: 50, unitPriceUnit: "kg" };
    pricesMedFjern.byEan["111"].history.HOLDBART = flatHistory(20, 60);

    const r = recommend({
      items: ITEMS,
      prices: pricesMedFjern,
      chains: [...CHAINS, "HOLDBART"],
      settings: { minSavingsPerStop: 10, maxStops: 3, maxKm: 12 },
      distanceByChain: { ...distances, HOLDBART: 45 },
      now: NOW,
    });

    assert.ok(!r.plan.chains.includes("HOLDBART"));
    assert.ok(r.excludedByDistance.includes("HOLDBART"));
  });

  test("nettbutikk uten avstand blir ikke filtrert bort", () => {
    const r = recommend({
      items: ITEMS,
      prices: PRICES,
      chains: [...CHAINS, "ODA_NO"],
      settings: { minSavingsPerStop: 15, maxStops: 3, maxKm: 12 },
      distanceByChain: distances, // ODA_NO mangler bevisst
      now: NOW,
    });
    assert.deepEqual(r.excludedByDistance, []);
  });

  test("maxStops respekteres", () => {
    const r = recommend({
      items: ITEMS,
      prices: PRICES,
      chains: CHAINS,
      settings: { minSavingsPerStop: 0, maxStops: 1, maxKm: 12 },
      distanceByChain: distances,
      now: NOW,
    });
    assert.equal(r.plan.chains.length, 1);
  });

  test("tom handleliste krasjer ikke", () => {
    const r = recommend({
      items: [],
      prices: PRICES,
      chains: CHAINS,
      settings: { minSavingsPerStop: 40, maxStops: 3, maxKm: 12 },
      distanceByChain: distances,
      now: NOW,
    });
    assert.equal(r.plan, null);
    assert.deepEqual(r.singles, []);
  });

  test("ingen valgte butikker krasjer ikke", () => {
    const r = recommend({
      items: ITEMS,
      prices: PRICES,
      chains: [],
      settings: { minSavingsPerStop: 40, maxStops: 3, maxKm: 12 },
      distanceByChain: {},
      now: NOW,
    });
    assert.equal(r.plan, null);
  });

  test("tomme priser krasjer ikke", () => {
    const r = recommend({
      items: ITEMS,
      prices: { builtAt: null, byEan: {} },
      chains: CHAINS,
      settings: { minSavingsPerStop: 40, maxStops: 3, maxKm: 12 },
      distanceByChain: distances,
      now: NOW,
    });
    assert.equal(r.plan.covered, 0);
    assert.equal(r.plan.total, 0);
  });
});

describe("extraCostPerItem", () => {
  test("viser hva du betaler ekstra der planen ikke er billigst", () => {
    const matrix = buildMatrix({ items: ITEMS, prices: PRICES, chains: CHAINS, now: NOW });
    const single = rankSingle({ matrix, items: ITEMS, chains: CHAINS });
    const plan = single[0];

    const extra = extraCostPerItem({ plan, matrix, items: ITEMS, chains: CHAINS });
    const kaffe = extra.find((e) => e.itemId === "kaffe");

    // Kiwi-kaffe 79,90 mot Rema 59,90 = 20 kr ekstra.
    assert.equal(kaffe.extra, 20);
    assert.equal(kaffe.cheapestChain, "REMA_1000");
    assert.equal(kaffe.planChain, "KIWI");
  });

  test("sorteres med den dyreste feilen først", () => {
    const matrix = buildMatrix({ items: ITEMS, prices: PRICES, chains: CHAINS, now: NOW });
    const single = rankSingle({ matrix, items: ITEMS, chains: CHAINS });
    const extra = extraCostPerItem({ plan: single[0], matrix, items: ITEMS, chains: CHAINS });
    assert.equal(extra[0].itemId, "kaffe");
  });
});
