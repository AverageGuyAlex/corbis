/**
 * Henter og lagrer appens data.
 *
 * Sannheten ligger i Netlify Blobs, slik at telefonen og PC-en ser det samme.
 * Vi speiler siste svar i localStorage også — da har du handlelista foran deg
 * med én gang du åpner appen, og den virker selv i en kjeller uten dekning.
 * Cachen brukes bare til å vise noe raskt; alt som lagres går til serveren.
 */

import { api, ApiError } from "./api.js";

const PREFIX = "corbis.cache.";

export const cache = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* full eller privat lagring — vi klarer oss uten cache */
    }
  },
};

/** Hva appen viser før serveren har svart. */
export function cachedState() {
  return {
    list: cache.get("list", { items: [], settings: {} }),
    stores: cache.get("stores", { selected: [], chains: {}, chainLabels: {} }),
    prices: cache.get("prices", { builtAt: null, byEan: {} }),
    candidates: cache.get("candidates", { byItem: {} }),
    fromCache: true,
  };
}

/**
 * Henter alt fra serveren. Kaster videre ved feil passord, slik at appen kan
 * vise passordvakta — men lar de andre feilene gå gjennom som delvis data,
 * siden en tom prismatrise er noe helt annet enn en tom handleliste.
 */
export async function loadAll() {
  const results = await Promise.allSettled([
    api.getList(),
    api.getStores(),
    api.getPrices(),
    api.getCandidates(),
  ]);

  const authFailure = results.find((r) => r.status === "rejected" && r.reason?.isAuth);
  if (authFailure) throw authFailure.reason;

  const [list, stores, prices, candidates] = results;
  // Fire like feilmeldinger er ikke fire opplysninger. Vis hver bare én gang.
  const errors = [
    ...new Set(
      results
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason?.message ?? "Ukjent feil"),
    ),
  ];

  const state = {
    list: list.status === "fulfilled" ? list.value : cache.get("list", { items: [], settings: {} }),
    stores:
      stores.status === "fulfilled"
        ? stores.value
        : cache.get("stores", { selected: [], chains: {}, chainLabels: {} }),
    prices:
      prices.status === "fulfilled" ? prices.value : cache.get("prices", { builtAt: null, byEan: {} }),
    candidates:
      candidates.status === "fulfilled" ? candidates.value : cache.get("candidates", { byItem: {} }),
    errors,
    fromCache: false,
  };

  if (list.status === "fulfilled") cache.set("list", state.list);
  if (stores.status === "fulfilled") cache.set("stores", state.stores);
  if (prices.status === "fulfilled") cache.set("prices", state.prices);
  if (candidates.status === "fulfilled") cache.set("candidates", state.candidates);

  return state;
}

export async function saveList(list) {
  const saved = await api.putList(list);
  cache.set("list", saved);
  return saved;
}

/**
 * Ber serveren starte en prisoppdatering.
 *
 * Den bygger ikke matrisen mens vi venter. Full oppdatering er ett API-kall
 * per strekkode og tar minutter, så serveren setter i gang en bakgrunnsjobb
 * og svarer med en gang. Framdriften leses av fetchPrices().
 */
export async function startRefresh({ force = false } = {}) {
  return api.rebuildPrices({ force });
}

/** Henter prismatrisen, inkludert status på en pågående oppdatering. */
export async function fetchPrices() {
  const prices = await api.getPrices();
  cache.set("prices", prices);
  return prices;
}

export { ApiError };
