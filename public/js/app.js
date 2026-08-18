/**
 * Corbis — UI-logikk.
 *
 * All prisregning skjer i optimizer.js, i nettleseren. Derfor kan du skru på
 * "min besparelse per stopp" eller ta bort en butikk og se planen endre seg
 * umiddelbart, uten et eneste API-kall.
 */

import { recommend, formatKr, formatUnitPrice } from "./optimizer.js";
import { api, getKey, setKey, clearKey } from "./api.js";
import { cachedState, loadAll, saveList, startRefresh, fetchPrices } from "./store.js";
import { el, replace, $ } from "./dom.js";
import { scannerSupported, startScan } from "./scanner.js";

// ---------------------------------------------------------------------------
// Tilstand
// ---------------------------------------------------------------------------

const state = {
  list: { items: [], settings: { minSavingsPerStop: 40, maxStops: 3, maxKm: 12 } },
  stores: { selected: [], chains: {}, chainLabels: {} },
  prices: { builtAt: null, byEan: {} },
  candidates: { byItem: {} },
  result: null,
  pricesStale: false,
  errors: [],
  // Hvilken vare som står åpen for redigering. Uten dette lukker panelet seg
  // hver gang en endring lagres og lista tegnes på nytt.
  expandedItemId: null,
};

const DEFAULT_SETTINGS = { minSavingsPerStop: 40, maxStops: 3, maxKm: 12 };

/** Fyller inn det som mangler, slik at UI-et aldri viser "undefined". */
function normalise() {
  state.list ??= { items: [], settings: {} };
  state.list.items = (state.list.items ?? []).map((item) => ({
    include: [],
    exclude: [],
    approvedEans: [],
    rejectedEans: [],
    lockedEan: null,
    allowSubstitute: true,
    qty: 1,
    qtyUnit: "kg",
    compareBy: "unit",
    ...item,
  }));
  state.list.settings = { ...DEFAULT_SETTINGS, ...(state.list.settings ?? {}) };
  state.stores ??= { selected: [], chains: {}, chainLabels: {} };
  state.prices ??= { builtAt: null, byEan: {} };
  state.candidates ??= { byItem: {} };
}

const ui = {};

// Skriving til serveren settes i kø, slik at to raske endringer ikke
// overskriver hverandre i tilfeldig rekkefølge.
let writeQueue = Promise.resolve();

// ---------------------------------------------------------------------------
// Hjelpere
// ---------------------------------------------------------------------------

const chainLabel = (code) =>
  state.stores.chainLabels?.[code] ?? state.stores.chains?.[code]?.label ?? code;

const chainList = () => Object.keys(state.stores.chains ?? {});

const distanceByChain = () =>
  Object.fromEntries(
    Object.entries(state.stores.chains ?? {}).map(([code, info]) => [code, info.nearestKm]),
  );

const BADGE_UI = {
  TILBUD: (cell) => ({
    cls: "badge--tilbud",
    text: `Tilbud ${cell.pctVsMedian} %`,
    title: `Normalpris er rundt ${formatKr(cell.medianPrice)} (median siste 60 dager).`,
  }),
  // Perioden kommer fra dataene, ikke fra en antakelse: hvor langt tilbake vi
  // ser varierer mellom ~25 og 90 dager avhengig av hva API-et ga oss.
  LAVESTE: (cell) => ({
    cls: "badge--laveste",
    text: cell.spanDays ? `Laveste på ${cell.spanDays} d` : "Laveste registrerte",
    title: `Lavere enn noe vi har registrert. Normalpris er rundt ${formatKr(cell.medianPrice)}.`,
  }),
  DYRT_NA: (cell) => ({
    cls: "badge--dyrt",
    text: `Dyrt nå +${cell.pctVsMedian} %`,
    title: `Over normalprisen på rundt ${formatKr(cell.medianPrice)}. Vent hvis du kan.`,
  }),
};

function badgeNode(cell) {
  const make = cell?.badge ? BADGE_UI[cell.badge] : null;
  if (!make) return null;
  const { cls, text, title } = make(cell);
  return el("span", { class: `badge ${cls}`, text, title });
}

/**
 * Produktbilde med reserve.
 *
 * Ramma har alltid faste mål, også når bildet mangler eller feiler — ellers
 * hopper lista mens de 25 bildene lastes, og da mister du plassen din i det du
 * scroller. Feiler bildet, byttes det ut med varens forbokstav, aldri et
 * knekt bildeikon.
 */
function thumb(src, label, size = "md") {
  const box = el("div", { class: `thumb thumb--${size}` });
  const fallback = () =>
    replace(
      box,
      el("span", {
        class: "thumb__fallback",
        text: String(label ?? "?").trim().charAt(0) || "?",
      }),
    );

  if (!src) {
    fallback();
    return box;
  }

  box.append(
    el("img", {
      src,
      alt: "",
      loading: "lazy",
      decoding: "async",
      referrerpolicy: "no-referrer",
      onError: fallback,
    }),
  );
  return box;
}

function dateLabel(iso) {
  if (!iso) return "aldri";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "ukjent";
  return d.toLocaleString("nb-NO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function qtyLabel(item) {
  if (item.compareBy === "pack") return `${item.qty} pk`;
  return `${item.qty} ${item.qtyUnit}`;
}

function toast(message, kind = "info") {
  const node = el("div", { class: `note ${kind === "bad" ? "note--bad" : "note--info"}`, text: message });
  replace(ui.toast, node);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => replace(ui.toast), 6000);
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    replace(button, el("span", { class: "spinner" }), " ", label ?? "Jobber…");
  } else if (button.dataset.label) {
    replace(button, button.dataset.label);
  }
}

// ---------------------------------------------------------------------------
// Lagring
// ---------------------------------------------------------------------------

/**
 * Lagrer lista. `itemsChanged: false` for rene innstillingsendringer — de
 * påvirker ikke hvilke priser vi trenger, så prismatrisen er fortsatt gyldig.
 */
function persist({ itemsChanged = true } = {}) {
  writeQueue = writeQueue
    .then(() => saveList({ items: state.list.items, settings: state.list.settings }))
    .then((saved) => {
      state.list = saved;
      normalise();
      if (itemsChanged) state.pricesStale = true;
      compute();
      render();
    })
    .catch((err) => toast(`Kunne ikke lagre: ${err.message}`, "bad"));
  return writeQueue;
}

// ---------------------------------------------------------------------------
// Beregning
// ---------------------------------------------------------------------------

function compute() {
  state.result = recommend({
    items: state.list.items,
    prices: state.prices,
    chains: chainList(),
    settings: state.list.settings,
    distanceByChain: distanceByChain(),
  });
}

// ---------------------------------------------------------------------------
// Planen
// ---------------------------------------------------------------------------

function renderPlan() {
  const root = ui.plan;
  const { items } = state.list;
  const result = state.result;

  if (chainList().length === 0) {
    return replace(
      root,
      el("div", { class: "empty" },
        el("strong", { text: "Ingen butikker valgt ennå" }),
        el("p", { class: "small", text: "Først må appen vite hvilke butikker du kan handle i." }),
        el("a", { class: "btn btn--primary", href: "butikker.html", text: "Velg butikker" }),
      ),
    );
  }

  if (items.length === 0) {
    return replace(
      root,
      el("div", { class: "empty" },
        el("strong", { text: "Handlelista er tom" }),
        el("p", { class: "small", text: "Legg inn varene du faktisk kjøper. Appen finner billigste kombinasjon." }),
        el("button", { class: "btn btn--primary", text: "Legg til første vare", onClick: () => { switchTab("liste"); openSearch({}); } }),
      ),
    );
  }

  if (!state.prices.builtAt) {
    return replace(
      root,
      el("div", { class: "empty" },
        el("strong", { text: "Ingen priser hentet ennå" }),
        el("p", { class: "small", text: "Cron-jobben henter priser hver morgen. Du kan også hente dem nå." }),
        el("button", { class: "btn btn--primary", text: "Hent priser", onClick: (e) => doRefreshPrices(e.currentTarget) }),
      ),
    );
  }

  const plan = result?.plan;
  const nodes = [];

  if (state.pricesStale) {
    nodes.push(
      el("div", { class: "note" },
        "Lista er endret siden prisene ble hentet. ",
        el("button", { class: "btn btn--sm", text: "Oppdater priser", onClick: (e) => doRefreshPrices(e.currentTarget, true) }),
      ),
    );
  }

  for (const note of state.prices.notes ?? []) {
    nodes.push(el("div", { class: "note", text: note }));
  }

  if (!plan || plan.covered === 0) {
    nodes.push(
      el("div", { class: "empty" },
        el("strong", { text: "Fant ingen priser for varene dine" }),
        el("p", { class: "small", text: "Varene mangler godkjente produkter, eller prisene er ikke hentet etter at du la dem inn." }),
      ),
    );
    return replace(root, nodes);
  }

  // --- Toppkortet: hva turen koster ---------------------------------------
  const stopWord = plan.chains.length === 1 ? "butikk" : "butikker";
  const hero = el("div", { class: "hero" },
    el("div", { class: "hero__total", text: formatKr(plan.total) }),
    el("div", { class: "hero__sub", text: `${plan.chains.length} ${stopWord} · ${plan.covered} av ${items.length} varer` }),
    // Navngi butikken vi sammenligner mot. "Mot å handle alt på ett sted" er
    // tvetydig når tabellen under viser en billigere butikk som mangler varer.
    result.savingsVsBestSingle > 0 && result.singles[0]
      ? el("div", { class: "hero__save", text: `Sparer ${formatKr(result.savingsVsBestSingle)} mot å handle alt hos ${chainLabel(result.singles[0].chain)}` })
      : null,
  );
  nodes.push(hero);

  if (plan.missing?.length) {
    nodes.push(
      el("div", { class: "note note--bad" },
        `Ingen av butikkene dine har: ${plan.missing.map(idToLabel).join(", ")}.`,
      ),
    );
  }
  if (plan.incomparable?.length) {
    nodes.push(
      el("div", { class: "note" },
        `Kan ikke prissammenlignes (mangler vekt eller enhet): ${plan.incomparable.map(idToLabel).join(", ")}.`,
      ),
    );
  }

  // --- Én seksjon per butikk ----------------------------------------------
  plan.chains.forEach((chain, index) => {
    const lines = items.filter((i) => plan.perItem[i.id]?.chain === chain);
    const sum = lines.reduce((acc, i) => acc + plan.perItem[i.id].cost, 0);
    const info = state.stores.chains?.[chain];
    const nearest = info?.stores?.[0];

    const stop = el("section", { class: "stop" },
      el("header", { class: "stop__head" },
        el("span", { class: "stop__n", text: String(index + 1) }),
        el("span", { class: "stop__name", text: chainLabel(chain) }),
        el("span", { class: "small muted nowrap", text: formatKr(Math.round(sum * 100) / 100) }),
      ),
      nearest
        ? el("div", { class: "line" },
            el("span", { class: "line__meta grow truncate", text: [nearest.name, nearest.address].filter(Boolean).join(" · ") }),
            Number.isFinite(nearest.km) ? el("span", { class: "line__meta nowrap", text: `${nearest.km} km` }) : null,
          )
        : null,
    );

    for (const item of lines) {
      const cell = state.result.matrix?.[item.id]?.[chain];
      stop.append(
        el("div", { class: "pline" },
          thumb(cell?.image, item.label, "lg"),
          el("div", { class: "pline__body" },
            el("div", { class: "pline__name", text: `${item.label} · ${qtyLabel(item)}` }),
            el("div", { class: "pline__product", text: cell?.name ?? "" }),
            el("div", { class: "pline__tags" },
              cell?.substitute
                ? el("span", {
                    class: "badge badge--erstatning",
                    text: "Erstatning",
                    title: "Denne kjeden har ingen av produktene du har godkjent. Dette er billigste tilsvarende vare i samme kategori.",
                  })
                : null,
              badgeNode(cell),
            ),
          ),
          el("div", { class: "pline__right" },
            el("div", { class: "pline__price", text: formatKr(plan.perItem[item.id].cost) }),
            cell?.basis === "unit" && cell?.unitPrice
              ? el("div", { class: "pline__unit", text: formatUnitPrice(cell.unitPrice, item.qtyUnit) })
              : null,
          ),
        ),
      );
    }

    nodes.push(stop);
  });

  // --- Hvor pengene forsvinner -------------------------------------------
  const extras = (result.extras ?? []).filter((e) => (e.extra ?? 0) > 0.005);
  if (extras.length) {
    const card = el("section", { class: "card card--flat" },
      el("div", { class: "card__head" },
        el("h3", { text: "Det du betaler ekstra" }),
        el("span", { class: "tiny muted", text: "mot billigste butikk i utvalget ditt" }),
      ),
    );
    for (const e of extras) {
      card.append(
        el("div", { class: "line" },
          el("div", { class: "line__main" },
            el("div", { class: "line__name", text: e.label }),
            el("div", { class: "line__meta", text: `${chainLabel(e.planChain)} ${formatKr(e.planCost)} · billigst hos ${chainLabel(e.cheapestChain)} ${formatKr(e.cheapestCost)}` }),
          ),
          el("div", { class: "line__price", text: `+${formatKr(e.extra)}` }),
        ),
      );
    }
    nodes.push(card);
  }

  // --- Rangering av alternativene ----------------------------------------
  nodes.push(renderRanking());

  // --- Ærlige forbehold --------------------------------------------------
  // Kjeder der ett prissett dekker flere butikkformater med reelt ulike priser.
  const omtrentlige = plan.chains.filter((c) => state.stores.chains?.[c]?.approximate);

  const antallErstatninger = items.filter((i) => {
    const c = plan.perItem[i.id];
    return c && state.result.matrix?.[i.id]?.[c.chain]?.substitute;
  }).length;

  nodes.push(
    el("section", { class: "card card--flat small muted" },
      el("p", { text: `Priser hentet ${dateLabel(state.prices.builtAt)}. Kassalapp oppdaterer én gang i døgnet, og feil kan forekomme.` }),
      el("p", { text: "Norske kjeder priser nasjonalt, så dette er billigst blant kjedene nær deg — ikke en garanti i kassa." }),
      omtrentlige.length
        ? el("p", { text: `${omtrentlige.map(chainLabel).join(", ")}: Kassalapp har ett felles prissett for alle butikkformatene. Extra, Prix og Mega har i virkeligheten ulike priser, så disse tallene er mer veiledende enn de andre.` })
        : null,
      antallErstatninger
        ? el("p", { text: `${antallErstatninger} av varene er erstatninger — billigste tilsvarende i samme kategori, ikke produktet du krysset av. De er merket i lista. Sammenlignbart er ikke det samme som identisk: sjekk gjerne pakningsstørrelsen på de dyreste postene.` })
        : null,
      result.excludedByDistance?.length
        ? el("p", { text: `Utelatt fordi de er lenger unna enn ${state.list.settings.maxKm} km: ${result.excludedByDistance.map(chainLabel).join(", ")}.` })
        : null,
    ),
  );

  replace(root, nodes);
}

function idToLabel(id) {
  return state.list.items.find((i) => i.id === id)?.label ?? id;
}

function renderRanking() {
  const { singles, steps, plan } = state.result;
  const planKey = plan?.chains?.join("+");

  const table = el("table", { class: "rank" },
    el("thead", {},
      el("tr", {},
        el("th", { text: "Alt på ett sted" }),
        el("th", { class: "num", text: "Total" }),
        el("th", { class: "num", text: "Dekker" }),
      ),
    ),
  );
  const tbody = el("tbody");
  for (const s of singles) {
    tbody.append(
      el("tr", { class: planKey === s.chain ? "is-plan" : "" },
        el("td", {},
          chainLabel(s.chain),
          Number.isFinite(state.stores.chains?.[s.chain]?.nearestKm)
            ? el("span", { class: "tiny muted", text: ` ${state.stores.chains[s.chain].nearestKm} km` })
            : null,
        ),
        // En butikk som ikke har noen av varene dine koster ikke 0 kr — den
        // er ubrukelig. Vis en strek, ellers ser den ut som den billigste.
        el("td", { class: "num", text: s.covered === 0 ? "–" : formatKr(s.total) }),
        el("td", { class: "num", text: `${s.covered}/${state.list.items.length}` }),
      ),
    );
  }
  table.append(tbody);

  const stepList = el("div", { class: "row small muted" },
    ...steps.map((s) =>
      el("span", { class: "chip", text: `${s.stops} stopp: ${formatKr(s.total)}` }),
    ),
  );

  return el("section", { class: "card" },
    el("div", { class: "card__head" }, el("h3", { text: "Alternativene" })),
    el("div", { class: "scroll-x" }, table),
    // Uten denne forklaringen ser det ut som en feil at den dyreste butikken
    // står øverst.
    el("p", { class: "tiny muted", text: "Sortert etter dekning først: en butikk som mangler varer er ikke billigere, bare ufullstendig." }),
    steps.length > 1 ? stepList : null,
  );
}

// ---------------------------------------------------------------------------
// Handlelista
// ---------------------------------------------------------------------------

function renderList() {
  const nodes = [];

  nodes.push(
    el("div", { class: "card" },
      el("div", { class: "card__head" }, el("h2", { text: "Handleliste" })),
      el("div", { class: "row" },
        el("button", { class: "btn btn--primary grow", text: "Legg til vare", onClick: () => openSearch({}) }),
        scannerSupported()
          ? el("button", { class: "btn", text: "Skann", onClick: () => openScanner() })
          : el("button", { class: "btn", text: "Strekkode", title: "Skriv inn tallene under strekkoden", onClick: () => openManualEan() }),
      ),
    ),
  );

  if (state.list.items.length === 0) {
    nodes.push(el("div", { class: "empty", text: "Ingen varer ennå." }));
  }

  for (const item of state.list.items) {
    nodes.push(renderItem(item));
  }

  nodes.push(renderSettings());
  replace(ui.liste, nodes);
}

/**
 * Bildet av den billigste godkjente varen akkurat nå.
 * Bytter du hvilke produkter som er godkjent, eller går et av dem ned i pris,
 * følger bildet etter av seg selv — det er nøklet på strekkode, ikke lagret.
 */
function itemImage(item) {
  const eans = item.lockedEan ? [item.lockedEan] : (item.approvedEans ?? []);
  let bestPrice = Infinity;
  let bestImage = null;
  let anyImage = null;

  for (const ean of eans) {
    const entry = state.prices.byEan?.[ean];
    if (!entry) continue;
    anyImage ??= entry.image ?? null;

    for (const row of Object.values(entry.stores ?? {})) {
      if (row.price < bestPrice) {
        bestPrice = row.price;
        bestImage = row.image ?? entry.image ?? null;
      }
    }
  }

  return bestImage ?? anyImage;
}

function renderItem(item) {
  const approved = item.lockedEan ? 1 : item.approvedEans.length;
  const open = state.expandedItemId === item.id;
  const detail = el("div", { class: "item__detail", hidden: !open });

  const card = el("article", { class: "item" },
    el("div", { class: "item__top" },
      thumb(itemImage(item), item.label, "md"),
      el("div", { class: "grow" },
        el("div", { class: "item__label", text: item.label }),
        el("div", { class: "tiny muted", text: `${qtyLabel(item)} · ${approved} ${approved === 1 ? "godkjent produkt" : "godkjente produkter"}${item.lockedEan ? " (låst)" : ""}` }),
      ),
      el("button", {
        class: "btn btn--sm", text: open ? "Lukk" : "Endre",
        onClick: (e) => {
          const nowOpen = detail.hidden;
          detail.hidden = !nowOpen;
          state.expandedItemId = nowOpen ? item.id : null;
          e.currentTarget.textContent = nowOpen ? "Lukk" : "Endre";
        },
      }),
    ),
    detail,
  );

  // --- Detaljer -----------------------------------------------------------
  const qtyInput = el("input", {
    type: "number", min: "0.1", step: "0.1", value: String(item.qty),
    onChange: (e) => { item.qty = Number(e.currentTarget.value) || 1; persist(); },
  });

  const compareSelect = el("select", {
    onChange: (e) => {
      item.compareBy = e.currentTarget.value;
      if (item.compareBy === "pack") item.qtyUnit = "stk";
      persist();
    },
  },
    el("option", { value: "unit", text: "Per kilo/liter (rettferdig)", selected: item.compareBy === "unit" }),
    el("option", { value: "pack", text: "Per pakke", selected: item.compareBy === "pack" }),
  );

  const unitSelect = el("select", {
    disabled: item.compareBy === "pack",
    onChange: (e) => { item.qtyUnit = e.currentTarget.value; persist(); },
  },
    ...["kg", "g", "l", "dl", "stk"].map((u) =>
      el("option", { value: u, text: u, selected: item.qtyUnit === u }),
    ),
  );

  const excludeInput = el("input", {
    type: "text", value: (item.exclude ?? []).join(", "),
    placeholder: "marinert, panert",
    onChange: (e) => {
      item.exclude = e.currentTarget.value.split(",").map((s) => s.trim()).filter(Boolean);
      persist();
    },
  });

  detail.append(
    el("div", { class: "grid2" },
      el("label", { class: "field" }, el("span", { text: "Mengde" }), qtyInput),
      el("label", { class: "field" }, el("span", { text: "Enhet" }), unitSelect),
      el("label", { class: "field" }, el("span", { text: "Sammenlign" }), compareSelect),
    ),
    el("label", { class: "field mt-s" },
      el("span", { text: "Utelukk ord (komma mellom)" }), excludeInput,
    ),
    el("label", { class: "row mt-m" },
      el("input", {
        type: "checkbox",
        checked: item.allowSubstitute !== false,
        onChange: (e) => {
          item.allowSubstitute = e.currentTarget.checked;
          persist();
        },
      }),
      el("span", { class: "small grow" },
        "Godta erstatning",
        el("span", { class: "tiny muted", text: " — billigste tilsvarende i samme kategori der butikken ikke har produktene dine" }),
      ),
    ),
    renderApprovedList(item),
    el("div", { class: "row mt-m" },
      el("button", { class: "btn btn--sm", text: "Finn flere produkter", onClick: () => openSearch({ item }) }),
      el("button", {
        class: "btn btn--sm btn--ghost", text: "Slett vare",
        onClick: () => {
          if (!confirm(`Slette "${item.label}" fra lista?`)) return;
          state.list.items = state.list.items.filter((i) => i.id !== item.id);
          persist();
        },
      }),
    ),
  );

  return card;
}

function renderApprovedList(item) {
  const wrap = el("div", { class: "mt-m" },
    el("div", { class: "tiny muted", text: "Godkjente produkter" }),
  );

  const eans = item.lockedEan ? [item.lockedEan] : item.approvedEans;
  if (eans.length === 0) {
    wrap.append(el("div", { class: "small muted", text: "Ingen ennå — søk opp varen og kryss av." }));
    return wrap;
  }

  for (const ean of eans) {
    const entry = state.prices.byEan?.[ean];
    const cheapest = entry
      ? Object.entries(entry.stores ?? {}).sort((a, b) => a[1].price - b[1].price)[0]
      : null;

    wrap.append(
      el("div", { class: "line" },
        thumb(cheapest?.[1]?.image ?? entry?.image, entry?.name ?? ean, "sm"),
        el("div", { class: "line__main" },
          el("div", { class: "small", text: entry?.name ?? `Strekkode ${ean}` }),
          el("div", { class: "line__meta", text: cheapest ? `Billigst: ${chainLabel(cheapest[0])} ${formatKr(cheapest[1].price)}` : "Ingen prisdata ennå" }),
        ),
        el("button", {
          class: item.lockedEan === ean ? "btn btn--sm btn--good" : "btn btn--sm",
          text: item.lockedEan === ean ? "Låst" : "Lås",
          title: item.lockedEan === ean
            ? "Låst til denne varen. Trykk for å tillate de andre igjen."
            : "Bruk bare denne varen — ingen erstatning, ingen av de andre godkjente.",
          onClick: () => {
            item.lockedEan = item.lockedEan === ean ? null : ean;
            persist();
          },
        }),
        el("button", {
          class: "btn btn--sm btn--ghost", text: "Fjern", title: "Fjern og aldri foreslå igjen",
          onClick: () => {
            item.approvedEans = item.approvedEans.filter((e) => e !== ean);
            if (item.lockedEan === ean) item.lockedEan = null;
            if (!item.rejectedEans.includes(ean)) item.rejectedEans.push(ean);
            persist();
          },
        }),
      ),
    );
  }

  return wrap;
}

function renderSettings() {
  const s = state.list.settings;
  const num = (key, label, min, max, step, hint) =>
    el("label", { class: "field" },
      el("span", { text: label }),
      el("input", {
        type: "number", min: String(min), max: String(max), step: String(step),
        value: String(s[key]),
        onChange: (e) => {
          const v = Number(e.currentTarget.value);
          // Innstillinger endrer bare hvordan vi regner, ikke hvilke priser
          // vi trenger — så prismatrisen blir ikke utdatert av dette.
          if (Number.isFinite(v)) { s[key] = v; persist({ itemsChanged: false }); }
        },
      }),
      hint ? el("span", { class: "tiny muted", text: hint }) : null,
    );

  return el("section", { class: "card" },
    el("div", { class: "card__head" }, el("h3", { text: "Innstillinger" })),
    el("div", { class: "grid2" },
      num("minSavingsPerStop", "Kroner per ekstra stopp", 0, 500, 5, "Under dette anbefales én butikk"),
      num("maxStops", "Maks antall butikker", 1, 4, 1),
      num("maxKm", "Maks avstand (km)", 1, 60, 1),
    ),
  );
}

// ---------------------------------------------------------------------------
// Nye treff
// ---------------------------------------------------------------------------

function pendingCount() {
  const fraSok = Object.values(state.candidates.byItem ?? {}).reduce(
    (sum, e) => sum + (e.candidates?.length ?? 0),
    0,
  );
  const fraErstatning = Object.values(state.candidates.substituteSuggestions ?? {}).reduce(
    (sum, e) => sum + Object.keys(e.byChain ?? {}).length,
    0,
  );
  return fraSok + fraErstatning;
}

/**
 * Erstatninger vi ikke tør bruke automatisk.
 *
 * Kjedene bruker ulike kategoritrær, så kategorifilteret gir falske negative:
 * Rema forsvant helt fra toalettpapir enda de hadde den billigste varen. I
 * stedet for å droppe butikken stille, spør vi deg én gang.
 */
function renderSubstituteSuggestions() {
  const entries = Object.entries(state.candidates.substituteSuggestions ?? {});
  if (entries.length === 0) return null;

  const nodes = [
    el("div", { class: "note note--info", text: "Disse butikkene mangler et godkjent produkt for varen din. Sier du ja, blir forslaget en godkjent vare og brukes i planen fra neste prisoppdatering." }),
  ];

  for (const [itemId, entry] of entries) {
    const card = el("section", { class: "card" },
      el("div", { class: "card__head" },
        el("h3", { text: entry.label ?? itemId }),
        el("span", { class: "tiny muted", text: "mangler i disse butikkene" }),
      ),
    );

    for (const [chain, sub] of Object.entries(entry.byChain ?? {})) {
      card.append(
        el("div", { class: "cand" },
          thumb(sub.image, sub.name ?? chain, "md"),
          el("div", { class: "cand__body" },
            el("div", { class: "cand__name", text: sub.name ?? `Strekkode ${sub.ean}` }),
            el("div", { class: "line__meta", text: `${chainLabel(chain)} · ${formatKr(sub.price)}` }),
            el("div", { class: "tiny muted", text: sub.categoryPath || "uten kategori hos Kassalapp" }),
          ),
          el("div", { class: "row nowrap" },
            el("button", {
              class: "btn btn--sm btn--good", text: "Ja",
              onClick: (e) => decide(itemId, sub.ean, "approve", e.currentTarget),
            }),
            el("button", {
              class: "btn btn--sm", text: "Nei",
              onClick: (e) => decide(itemId, sub.ean, "reject", e.currentTarget),
            }),
          ),
        ),
      );
    }
    nodes.push(card);
  }

  return nodes;
}

function renderInbox() {
  const entries = Object.entries(state.candidates.byItem ?? {});
  const erstatninger = renderSubstituteSuggestions();

  if (entries.length === 0 && !erstatninger) {
    return replace(ui.nytt,
      el("div", { class: "empty" },
        el("strong", { text: "Ingenting nytt" }),
        el("p", { class: "small", text: "Hver morgen leter appen etter nye produkter som matcher varene dine. Nye treff dukker opp her." }),
      ),
    );
  }

  const nodes = [];

  // Manglende butikker først — de påvirker planen din akkurat nå.
  if (erstatninger) nodes.push(erstatninger);

  if (entries.length) {
    nodes.push(
      el("div", { class: "note note--info", text: "Si ja eller nei én gang — appen husker svaret og spør ikke igjen." }),
    );
  }

  for (const [itemId, entry] of entries) {
    const card = el("section", { class: "card" },
      el("div", { class: "card__head" },
        el("h3", { text: entry.label ?? itemId }),
        el("span", { class: "tiny muted", text: `${entry.candidates.length} forslag` }),
      ),
    );

    for (const cand of entry.candidates) {
      card.append(candidateRow(cand, {
        actions: [
          el("button", {
            class: "btn btn--sm btn--good", text: "Ja",
            onClick: (e) => decide(itemId, cand.ean, "approve", e.currentTarget),
          }),
          el("button", {
            class: "btn btn--sm", text: "Nei",
            onClick: (e) => decide(itemId, cand.ean, "reject", e.currentTarget),
          }),
        ],
      }));
    }

    nodes.push(card);
  }

  replace(ui.nytt, nodes);
}

async function decide(itemId, ean, verdict, button) {
  setBusy(button, true, "");
  try {
    const res = await api.decide({
      itemId,
      approve: verdict === "approve" ? [ean] : [],
      reject: verdict === "reject" ? [ean] : [],
    });
    // Speil svaret lokalt så UI-et ikke må hente alt på nytt.
    const item = state.list.items.find((i) => i.id === itemId);
    if (item) {
      item.approvedEans = res.item.approvedEans;
      item.rejectedEans = res.item.rejectedEans;
    }
    const entry = state.candidates.byItem?.[itemId];
    if (entry) {
      entry.candidates = entry.candidates.filter((c) => c.ean !== ean);
      if (entry.candidates.length === 0) delete state.candidates.byItem[itemId];
    }

    // Samme svar gjelder erstatningsforslaget, om det var derfra du svarte.
    const forslag = state.candidates.substituteSuggestions?.[itemId];
    if (forslag) {
      for (const [chain, sub] of Object.entries(forslag.byChain ?? {})) {
        if (sub.ean === ean) delete forslag.byChain[chain];
      }
      if (Object.keys(forslag.byChain ?? {}).length === 0) {
        delete state.candidates.substituteSuggestions[itemId];
      }
    }
    if (res.pricesStale) state.pricesStale = true;
    compute();
    render();
  } catch (err) {
    setBusy(button, false);
    toast(err.message, "bad");
  }
}

// ---------------------------------------------------------------------------
// Søk og godkjenning
// ---------------------------------------------------------------------------

function candidateRow(cand, { actions = [], checkbox = null } = {}) {
  const chains = Object.entries(cand.chains ?? {}).sort((a, b) => a[1].price - b[1].price);
  const priceText = chains
    .slice(0, 4)
    .map(([code, p]) => `${chainLabel(code)} ${formatKr(p.price)}`)
    .join(" · ");

  return el("div", { class: "cand" },
    checkbox,
    thumb(cand.image, cand.name ?? cand.ean, "md"),
    el("div", { class: "cand__body" },
      el("div", { class: "cand__name", text: cand.name ?? `Strekkode ${cand.ean}` }),
      el("div", { class: "line__meta" },
        [cand.brand, cand.weight ? `${cand.weight} ${cand.weightUnit ?? ""}`.trim() : null]
          .filter(Boolean).join(" · "),
      ),
      el("div", { class: "line__meta", text: priceText || "Ingen pris" }),
      Number.isFinite(cand.bestUnitPrice)
        ? el("div", { class: "tiny muted", text: `fra ${formatUnitPrice(cand.bestUnitPrice, cand.weightUnit === "l" || cand.weightUnit === "dl" || cand.weightUnit === "ml" ? "l" : "kg")}` })
        : null,
    ),
    actions.length ? el("div", { class: "row nowrap" }, ...actions) : null,
  );
}

/**
 * Søkedialogen. Med `item` legger vi til flere godkjente produkter på en
 * eksisterende vare; uten oppretter vi en ny vare fra søkeordet.
 */
function openSearch({ item = null, prefill = "" } = {}) {
  const dlg = ui.dialog;
  const results = el("div", { class: "stack" });
  const picked = new Set();

  const input = el("input", {
    type: "search", placeholder: "kyllingfilet", value: prefill || item?.search || "",
    enterkeyhint: "search",
  });
  const excludeInput = el("input", {
    type: "text", placeholder: "marinert, panert", value: (item?.exclude ?? []).join(", "),
  });

  const addBtn = el("button", { class: "btn btn--primary", disabled: true, text: item ? "Legg til valgte" : "Opprett vare" });
  const searchBtn = el("button", { class: "btn", text: "Søk" });

  const updateAddBtn = () => {
    addBtn.disabled = picked.size === 0;
    addBtn.textContent = item
      ? `Legg til ${picked.size || ""}`.trim()
      : `Opprett vare (${picked.size})`;
  };

  async function doSearch() {
    const q = input.value.trim();
    if (q.length < 3) return toast("Søkeordet må ha minst 3 tegn.", "bad");

    setBusy(searchBtn, true, "Søker…");
    replace(results, el("p", { class: "small muted", text: "Søker hos Kassalapp… dette tar noen sekunder." }));

    try {
      const exclude = excludeInput.value.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await api.search({ q, exclude });

      const rejected = new Set(item?.rejectedEans ?? []);
      const already = new Set(item?.approvedEans ?? []);
      const list = res.candidates.filter((c) => !rejected.has(c.ean) && !already.has(c.ean));

      if (list.length === 0) {
        replace(results, el("p", { class: "small muted", text: "Ingen nye treff. Prøv et annet søkeord, eller fjern noen utelukk-ord." }));
        return;
      }

      const nodes = [
        el("p", { class: "tiny muted", text: `${list.length} varer · ${res.filteredOut} filtrert bort av ordene dine · sortert etter billigste kilopris` }),
      ];

      for (const cand of list) {
        const box = el("input", {
          type: "checkbox",
          onChange: (e) => {
            if (e.currentTarget.checked) picked.add(cand.ean);
            else picked.delete(cand.ean);
            updateAddBtn();
          },
        });
        nodes.push(candidateRow(cand, { checkbox: box }));
      }
      replace(results, nodes);
    } catch (err) {
      replace(results, el("div", { class: "note note--bad", text: err.message }));
    } finally {
      setBusy(searchBtn, false);
      updateAddBtn();
    }
  }

  searchBtn.addEventListener("click", doSearch);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doSearch(); }
  });

  addBtn.addEventListener("click", () => {
    const eans = [...picked];
    const exclude = excludeInput.value.split(",").map((s) => s.trim()).filter(Boolean);

    if (item) {
      item.approvedEans = [...new Set([...item.approvedEans, ...eans])];
      item.exclude = exclude;
    } else {
      const label = input.value.trim();
      state.list.items.push({
        id: label.toLowerCase().replace(/[^a-z0-9æøå]+/g, "-"),
        label: label.charAt(0).toUpperCase() + label.slice(1),
        qty: 1,
        qtyUnit: "kg",
        compareBy: "unit",
        search: label,
        include: [],
        exclude,
        categoryId: null,
        approvedEans: eans,
        rejectedEans: [],
        lockedEan: null,
      });
    }
    dlg.close();
    persist();
    toast("Lagret. Husk å oppdatere prisene for å få dem med i planen.");
  });

  replace(dlg,
    el("div", { class: "card__head" },
      el("h2", { text: item ? `Flere produkter for ${item.label}` : "Ny vare" }),
      el("button", { class: "btn btn--sm btn--ghost", text: "Lukk", onClick: () => dlg.close() }),
    ),
    el("p", { class: "small muted", text: "Kryss av alt som teller som samme vare for deg. Butikkenes egne merker er ofte billigst — de er verdt å ta med." }),
    el("label", { class: "field" }, el("span", { text: "Søk" }), input),
    el("label", { class: "field mt-xs" }, el("span", { text: "Utelukk ord" }), excludeInput),
    el("div", { class: "row my-m" }, searchBtn, addBtn),
    results,
  );

  dlg.showModal();
  input.focus();
  if (input.value.trim().length >= 3) doSearch();
}

// ---------------------------------------------------------------------------
// Strekkode
// ---------------------------------------------------------------------------

async function handleEan(ean) {
  try {
    const res = await api.lookupEan(ean);
    if (!res.candidates?.length) return toast(`Fant ingen vare med strekkode ${ean}.`, "bad");
    const cand = res.candidates[0];
    openSearch({ prefill: (cand.name ?? "").split(" ").slice(0, 2).join(" ") });
    toast(`${cand.name ?? ean} — søk opp varen og kryss av hva som teller som samme ting.`);
  } catch (err) {
    toast(err.message, "bad");
  }
}

function openManualEan() {
  const dlg = ui.dialog;
  const input = el("input", { type: "text", inputmode: "numeric", placeholder: "7035620038204" });
  replace(dlg,
    el("div", { class: "card__head" },
      el("h2", { text: "Skriv inn strekkode" }),
      el("button", { class: "btn btn--sm btn--ghost", text: "Lukk", onClick: () => dlg.close() }),
    ),
    el("p", { class: "small muted", text: "Denne nettleseren har ikke innebygd strekkodeleser. Skriv inn tallene under strekkoden." }),
    el("label", { class: "field" }, el("span", { text: "Strekkode" }), input),
    el("div", { class: "row mt-m" },
      el("button", {
        class: "btn btn--primary", text: "Søk opp",
        onClick: () => {
          const digits = input.value.replace(/\D/g, "");
          if (digits.length < 6) return toast("Strekkoden ser for kort ut.", "bad");
          dlg.close();
          handleEan(digits);
        },
      }),
    ),
  );
  dlg.showModal();
  input.focus();
}

async function openScanner() {
  const dlg = ui.dialog;
  const video = el("video", { playsinline: true, muted: true });
  let stop = null;

  const close = () => { stop?.(); dlg.close(); };

  replace(dlg,
    el("div", { class: "card__head" },
      el("h2", { text: "Skann strekkode" }),
      el("button", { class: "btn btn--sm btn--ghost", text: "Lukk", onClick: close }),
    ),
    el("div", { class: "scanbox" }, video, el("div", { class: "scanbox__frame" })),
    el("p", { class: "small muted mt-m", text: "Hold strekkoden innenfor rammen." }),
  );

  dlg.addEventListener("close", () => stop?.(), { once: true });
  dlg.showModal();

  try {
    stop = await startScan({
      video,
      onResult: (ean) => { close(); handleEan(ean); },
    });
  } catch (err) {
    close();
    toast(err.message, "bad");
    openManualEan();
  }
}

// ---------------------------------------------------------------------------
// Priser
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starter prisoppdateringen og følger den til mål.
 *
 * Serveren svarer med en gang og gjør jobben i bakgrunnen, fordi hver
 * strekkode koster ett API-kall med drøyt et sekunds mellomrom. Vi spør derfor
 * jevnlig om framdrift i stedet for å vente på ett langt svar.
 */
async function doRefreshPrices(button, force = false) {
  const alive = () => button?.isConnected;
  setBusy(button, true, "Starter…");
  const before = state.prices.builtAt;

  try {
    const res = await startRefresh({ force });

    if (res?.started === false) {
      if (res.error) {
        toast(res.error, "bad");
        return;
      }
      // Fersk nok, eller allerede i gang. Begge deler er greit å si fra om.
      toast(res.message ?? "Ingen oppdatering nødvendig.");
      if (!res.alreadyRunning) return;
    } else {
      toast(res?.message ?? "Oppdatering startet i bakgrunnen.");
    }

    // Ti minutter er romslig: 150 strekkoder tar rundt tre.
    const deadline = Date.now() + 10 * 60_000;

    while (Date.now() < deadline) {
      await sleep(5000);

      const prices = await fetchPrices();
      state.prices = prices;
      const status = prices.refresh ?? {};

      if (alive() && status.total) setBusy(button, true, `${status.done}/${status.total}`);

      compute();
      render();

      if (!status.running) {
        if (status.error) {
          toast(`Oppdateringen feilet: ${status.error}`, "bad");
        } else if (prices.builtAt !== before) {
          state.pricesStale = false;
          toast(`Priser oppdatert ${dateLabel(prices.builtAt)}.`);
        } else {
          // Jobben er ikke i gang og ingenting ble skrevet — den kom aldri opp.
          toast("Oppdateringen ser ikke ut til å ha startet. Sjekk funksjonsloggen i Netlify.", "bad");
        }
        return;
      }
    }

    toast("Oppdateringen tar uvanlig lang tid. Last siden på nytt for å se hvor den står.", "bad");
  } catch (err) {
    toast(err.message, "bad");
  } finally {
    if (alive()) setBusy(button, false);
  }
}

// ---------------------------------------------------------------------------
// Faner og oppstart
// ---------------------------------------------------------------------------

function switchTab(name) {
  for (const tab of ["plan", "liste", "nytt"]) {
    ui[`tab_${tab}`].setAttribute("aria-selected", String(tab === name));
    ui[tab].hidden = tab !== name;
  }
}

function render() {
  renderPlan();
  renderList();
  renderInbox();

  const count = pendingCount();
  replace(ui.tabCount, count ? el("span", { class: "count", text: String(count) }) : null);

  if (state.errors.length) {
    toast(state.errors.join(" · "), "bad");
    state.errors = [];
  }
}

function showGate(message) {
  const input = el("input", { type: "password", placeholder: "Passord", autocomplete: "current-password" });
  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    setKey(value);
    ui.gate.hidden = true;
    boot();
  };

  replace(ui.gate,
    el("div", { class: "gate" },
      el("h1", { text: "Corbis" }),
      el("p", { class: "small muted", text: "Handlekurv-optimaliserer for Kristiansand" }),
      el("div", { class: "card" },
        message ? el("div", { class: "note note--bad", text: message }) : null,
        el("label", { class: "field" }, el("span", { text: "Passord" }), input),
        el("button", { class: "btn btn--primary btn--block mt-m", text: "Åpne", onClick: submit }),
      ),
    ),
  );
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  ui.gate.hidden = false;
  ui.app.hidden = true;
  input.focus();
}

async function boot() {
  ui.app.hidden = false;

  // Vis det vi husker med én gang, så appen ikke er tom mens vi venter.
  Object.assign(state, cachedState());
  normalise();
  compute();
  render();

  try {
    const fresh = await loadAll();
    Object.assign(state, fresh);
    normalise();
    compute();
    render();
  } catch (err) {
    if (err.isAuth) {
      clearKey();
      return showGate("Feil passord. Prøv igjen.");
    }
    toast(err.message, "bad");
  }
}

function init() {
  ui.app = $("#app");
  ui.gate = $("#gate");
  ui.toast = $("#toast");
  ui.plan = $("#panel-plan");
  ui.liste = $("#panel-liste");
  ui.nytt = $("#panel-nytt");
  ui.tab_plan = $("#tab-plan");
  ui.tab_liste = $("#tab-liste");
  ui.tab_nytt = $("#tab-nytt");
  ui.tabCount = $("#tab-count");
  ui.dialog = $("#dialog");

  ui.tab_plan.addEventListener("click", () => switchTab("plan"));
  ui.tab_liste.addEventListener("click", () => switchTab("liste"));
  ui.tab_nytt.addEventListener("click", () => switchTab("nytt"));
  $("#refresh").addEventListener("click", (e) => doRefreshPrices(e.currentTarget, true));
  $("#logout").addEventListener("click", () => { clearKey(); location.reload(); });

  switchTab("plan");

  if (getKey()) boot();
  else showGate();
}

document.addEventListener("DOMContentLoaded", init);
