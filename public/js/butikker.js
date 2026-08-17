/**
 * Butikkoppsettet — engangsjobben.
 *
 * Her oversetter appen mellom "butikker i Kristiansand" og "kjeder med priser":
 * du krysser av butikkene du realistisk kan innom, og optimalisereren jobber
 * videre med kjedene de tilhører, pluss avstanden til den nærmeste av dem.
 */

import { api, getKey } from "./api.js";
import { el, replace, $ } from "./dom.js";

const selected = new Map(); // id → butikkobjekt
let chainLabels = {};

const $lat = () => $("#lat");
const $lng = () => $("#lng");
const $km = () => $("#km");

function toast(message, kind = "info") {
  replace($("#toast"), el("div", { class: `note ${kind === "bad" ? "note--bad" : "note--info"}`, text: message }));
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => replace($("#toast")), 6000);
}

const chainLabel = (code) => chainLabels[code] ?? code;

/**
 * openingHours er dokumentert som "object" uten nærmere form, så vi tolker
 * det vi kjenner igjen og viser resten som den er, framfor å anta en form
 * som kanskje ikke stemmer.
 */
function openingHoursText(oh) {
  if (!oh) return null;
  if (typeof oh === "string") return oh;

  const parts = [];
  for (const [day, value] of Object.entries(oh)) {
    let text = null;
    if (typeof value === "string") text = value;
    else if (value && typeof value === "object") {
      const open = value.open ?? value.opens ?? value.from;
      const close = value.close ?? value.closes ?? value.to;
      if (open || close) text = `${open ?? "?"}–${close ?? "?"}`;
    }
    if (text) parts.push(`${day.slice(0, 3)} ${text}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

function updateSummary() {
  const chains = new Set([...selected.values()].map((s) => s.chain));
  const text = selected.size
    ? `${selected.size} butikker · ${chains.size} kjeder: ${[...chains].map(chainLabel).join(", ")}`
    : "Ingen butikker valgt";
  replace($("#summary"), text);
}

function storeRow(store) {
  const id = String(store.id);
  const hours = openingHoursText(store.openingHours);

  const box = el("input", {
    type: "checkbox",
    checked: selected.has(id),
    onChange: (e) => {
      if (e.currentTarget.checked) selected.set(id, store);
      else selected.delete(id);
      updateSummary();
    },
  });

  return el("label", { class: "store" },
    box,
    el("div", { class: "store__body" },
      el("div", { class: "store__name", text: store.name }),
      el("div", { class: "small muted", text: [store.address, Number.isFinite(store.km) ? `${store.km} km` : null].filter(Boolean).join(" · ") }),
      hours ? el("div", { class: "tiny muted", text: hours }) : null,
    ),
  );
}

function renderStores(stores, { title, hint }) {
  const byChain = new Map();
  for (const s of stores) {
    if (!s.chain) continue;
    if (!byChain.has(s.chain)) byChain.set(s.chain, []);
    byChain.get(s.chain).push(s);
  }

  // Kjeden med nærmeste butikk først — det er den du mest sannsynlig vil ha.
  const chains = [...byChain.entries()].sort((a, b) => {
    const an = Math.min(...a[1].map((s) => s.km ?? Infinity));
    const bn = Math.min(...b[1].map((s) => s.km ?? Infinity));
    return an - bn;
  });

  const nodes = [
    el("div", { class: "card__head" },
      el("h2", { text: title }),
      el("span", { class: "tiny muted", text: `${stores.length} butikker` }),
    ),
    hint ? el("p", { class: "small muted", text: hint }) : null,
  ];

  for (const [chain, list] of chains) {
    const card = el("section", { class: "card" },
      el("div", { class: "card__head" },
        el("h3", { text: chainLabel(chain) }),
        el("button", {
          class: "btn btn--sm", text: "Velg nærmeste",
          onClick: () => {
            const nearest = list.slice().sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity))[0];
            if (nearest) selected.set(String(nearest.id), nearest);
            renderStores(stores, { title, hint });
            updateSummary();
          },
        }),
      ),
      ...list
        .slice()
        .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity))
        .map(storeRow),
    );
    nodes.push(card);
  }

  replace($("#results"), nodes);
}

async function doSearch(button) {
  const lat = Number($lat().value);
  const lng = Number($lng().value);
  const km = Number($km().value);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return toast("Koordinatene ser ikke riktige ut.", "bad");
  }

  button.disabled = true;
  const label = button.textContent;
  button.textContent = "Søker…";
  replace($("#results"), el("p", { class: "small muted", text: "Henter butikker fra Kassalapp…" }));

  try {
    const res = await api.findNearby({ lat, lng, km });
    chainLabels = res.chainLabels ?? chainLabels;

    if (!res.nearby?.length) {
      replace($("#results"), el("div", { class: "note", text: "Fant ingen dagligvarebutikker innenfor radiusen. Prøv å øke den." }));
      return;
    }

    renderStores(res.nearby, {
      title: `Butikker innenfor ${km} km`,
      hint: "Kryss av de du realistisk kan innom. Har du to Kiwi-butikker i nærheten, trenger du bare den nærmeste — prisene er like.",
    });
  } catch (err) {
    replace($("#results"), el("div", { class: "note note--bad", text: err.message }));
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function doSave(button) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "Lagrer…";

  try {
    await api.putStores({
      home: { lat: Number($lat().value), lng: Number($lng().value), label: "Hjemme" },
      km: Number($km().value),
      selected: [...selected.values()],
    });
    toast("Lagret. Gå tilbake til planen — husk å oppdatere prisene hvis du la til en ny kjede.");
  } catch (err) {
    toast(err.message, "bad");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function locate(button) {
  if (!navigator.geolocation) return toast("Nettleseren støtter ikke posisjon.", "bad");

  button.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $lat().value = pos.coords.latitude.toFixed(4);
      $lng().value = pos.coords.longitude.toFixed(4);
      replace($("#home-label"), "Bruker din nåværende posisjon.");
      button.disabled = false;
      toast("Posisjon hentet. Trykk «Søk opp butikker».");
    },
    () => {
      button.disabled = false;
      toast("Fikk ikke posisjonen din. Skriv inn koordinatene manuelt, eller behold Kristiansand sentrum.", "bad");
    },
    { timeout: 10_000 },
  );
}

async function init() {
  if (!getKey()) {
    location.replace("index.html");
    return;
  }

  $("#search").addEventListener("click", (e) => doSearch(e.currentTarget));
  $("#save").addEventListener("click", (e) => doSave(e.currentTarget));
  $("#locate").addEventListener("click", (e) => locate(e.currentTarget));

  try {
    const saved = await api.getStores();
    chainLabels = saved.chainLabels ?? {};

    if (Number.isFinite(saved.home?.lat)) $lat().value = saved.home.lat;
    if (Number.isFinite(saved.home?.lng)) $lng().value = saved.home.lng;
    if (Number.isFinite(saved.km)) $km().value = saved.km;

    for (const store of saved.selected ?? []) selected.set(String(store.id), store);
    updateSummary();

    if (selected.size) {
      renderStores([...selected.values()], {
        title: "Butikkene du har valgt",
        hint: "Søk på nytt for å legge til flere, eller fjern avkryssing for å ta dem ut.",
      });
    } else {
      replace($("#results"),
        el("div", { class: "empty" },
          el("strong", { text: "Ingen butikker valgt ennå" }),
          el("p", { class: "small", text: "Trykk «Søk opp butikker» for å se hva som finnes rundt deg." }),
        ),
      );
    }
  } catch (err) {
    if (err.isAuth) {
      location.replace("index.html");
      return;
    }
    toast(err.message, "bad");
  }
}

document.addEventListener("DOMContentLoaded", init);
