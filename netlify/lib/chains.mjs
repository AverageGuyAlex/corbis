/**
 * Kjedekodene Kassalapp bruker, med norske visningsnavn.
 *
 * Bare dagligvare er med. Kassalapp har også ARK, NORLI og ADLIBRIS (bok) og
 * COOP_BYGGMIX, COOP_OBS_BYGG, COOP_ELEKTRO (bygg/elektro) — de har ingenting
 * å gjøre i en matbudsjett-sammenligning og er derfor utelatt.
 *
 * Frontenden slår aldri opp koder selv; den får navnene herfra via
 * /api/stores. Da finnes lista bare på ett sted.
 */

export const GROCERY_CHAINS = {
  KIWI: { label: "Kiwi", tier: "lavpris" },
  REMA_1000: { label: "Rema 1000", tier: "lavpris" },
  COOP_EXTRA: { label: "Coop Extra", tier: "lavpris" },
  COOP_PRIX: { label: "Coop Prix", tier: "lavpris" },
  BUNNPRIS: { label: "Bunnpris", tier: "nærbutikk" },
  MENY_NO: { label: "Meny", tier: "supermarked" },
  SPAR_NO: { label: "Spar", tier: "supermarked" },
  JOKER_NO: { label: "Joker", tier: "nærbutikk" },
  COOP_MEGA: { label: "Coop Mega", tier: "supermarked" },
  COOP_OBS: { label: "Obs", tier: "hypermarked" },
  COOP_MARKED: { label: "Coop Marked", tier: "nærbutikk" },
  MATKROKEN: { label: "Matkroken", tier: "nærbutikk" },
  NAERBUTIKKEN: { label: "Nærbutikken", tier: "nærbutikk" },
  ODA_NO: { label: "Oda (nettbutikk)", tier: "nett" },
  HOLDBART: { label: "Holdbart", tier: "restevarer" },
  HAVARISTEN: { label: "Havaristen", tier: "restevarer" },
  EUROPRIS_NO: { label: "Europris", tier: "diverse" },
  FUDI: { label: "Fudi", tier: "nett" },
};

export const GROCERY_CODES = Object.keys(GROCERY_CHAINS);

export function isGroceryChain(code) {
  return Object.prototype.hasOwnProperty.call(GROCERY_CHAINS, code);
}

export function chainLabel(code) {
  return GROCERY_CHAINS[code]?.label ?? code;
}

/** Kart over alle koder → navn, sendes til frontenden. */
export function chainLabels() {
  return Object.fromEntries(GROCERY_CODES.map((c) => [c, GROCERY_CHAINS[c].label]));
}
