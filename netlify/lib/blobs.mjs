/**
 * All lagring skjer i én Netlify Blobs-store som heter "corbis".
 *
 * VIKTIG: ikke døp om store-navnet eller nøklene under. Gjør du det, mister
 * du handlelista og alle godkjente strekkoder — samme grunn som at
 * scrollswap_*-nøklene i Rotulus er fredet.
 *
 * Vi bruker "strong" konsistens fordi du lagrer lista på PC-en og forventer
 * å se den på telefonen sekunder senere. Med standard (eventual) konsistens
 * kan endringen bruke opptil 60 sekunder på å nå alle noder.
 */

import { getStore } from "@netlify/blobs";

export const STORE_NAME = "corbis";

export const KEYS = {
  list: "list",
  stores: "stores",
  prices: "prices",
  candidates: "candidates",
};

export const DEFAULTS = {
  list: {
    items: [],
    settings: {
      minSavingsPerStop: 40,
      maxStops: 3,
      maxKm: 12,
    },
    updatedAt: null,
  },
  stores: {
    home: { lat: 58.1467, lng: 7.9956, label: "Kristiansand sentrum" },
    km: 12,
    selected: [],
    updatedAt: null,
  },
  prices: {
    builtAt: null,
    byEan: {},
    notes: [],
  },
  candidates: {
    cursor: 0,
    byItem: {},
    updatedAt: null,
  },
};

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export async function readJSON(key) {
  const value = await store().get(key, { type: "json" });
  if (value === null || value === undefined) {
    return structuredClone(DEFAULTS[key] ?? null);
  }
  return value;
}

export async function writeJSON(key, value) {
  await store().setJSON(key, value);
  return value;
}
