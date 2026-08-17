/**
 * Kjedekoder i Kassalapp — og hvorfor det finnes to sett av dem.
 *
 * Dette er ikke overkomplisert med vilje. Kassalapp bruker faktisk to ulike
 * kodesett, og de overlapper ikke:
 *
 *   PRISER  (/products)         merker ALLE Coop-varer med  COOP_NO
 *   BUTIKKER(/physical-stores)  merker butikkene med        COOP_EXTRA,
 *                                COOP_PRIX, COOP_MEGA, COOP_OBS, COOP_MARKED
 *
 * Målt mot ekte API: `store=COOP_EXTRA` gir 0 produkter, `store=COOP_NO` gir
 * 100. Uten oversettelsen under forsvinner Coop helt ut av appen — og av de
 * 100 butikkene innenfor 12 km av Kristiansand sentrum er 42 Coop. Det er den
 * største kjedetilstedeværelsen i byen.
 *
 * Derfor: PRICE_CHAINS er det priser er merket med, STORE_GROUPS er det
 * butikker er merket med, og priceChainFor() oversetter mellom dem.
 */

/** Kodene som dukker opp i produkt- og prisdata. */
export const PRICE_CHAINS = {
  KIWI: { label: "Kiwi" },
  REMA_1000: { label: "Rema 1000" },
  COOP_NO: { label: "Coop" },
  BUNNPRIS: { label: "Bunnpris" },
  MENY_NO: { label: "Meny" },
  SPAR_NO: { label: "Spar" },
  JOKER_NO: { label: "Joker" },
  MATKROKEN: { label: "Matkroken" },
  NAERBUTIKKEN: { label: "Nærbutikken" },
  ODA_NO: { label: "Oda (nettbutikk)" },
  HOLDBART: { label: "Holdbart" },
  HAVARISTEN: { label: "Havaristen" },
  EUROPRIS_NO: { label: "Europris" },
  ENGROSSNETT_NO: { label: "Engrossnett" },
  FUDI: { label: "Fudi" },
};

/**
 * Kodene som dukker opp på fysiske butikker, med hvilken priskjede de hører
 * til. Bygg- og bokhandelkjedene (COOP_BYGGMIX, COOP_OBS_BYGG, COOP_ELEKTRO,
 * ARK, NORLI, ADLIBRIS) er bevisst utelatt — de skal ikke inn i et matbudsjett.
 */
export const STORE_GROUPS = {
  KIWI: { label: "Kiwi", priceChain: "KIWI" },
  REMA_1000: { label: "Rema 1000", priceChain: "REMA_1000" },

  // Alle Coop-formater deler ett prissett hos Kassalapp.
  COOP_NO: { label: "Coop", priceChain: "COOP_NO" },
  COOP_EXTRA: { label: "Coop Extra", priceChain: "COOP_NO" },
  COOP_PRIX: { label: "Coop Prix", priceChain: "COOP_NO" },
  COOP_MEGA: { label: "Coop Mega", priceChain: "COOP_NO" },
  COOP_OBS: { label: "Obs", priceChain: "COOP_NO" },
  COOP_MARKED: { label: "Coop Marked", priceChain: "COOP_NO" },

  BUNNPRIS: { label: "Bunnpris", priceChain: "BUNNPRIS" },
  MENY_NO: { label: "Meny", priceChain: "MENY_NO" },
  SPAR_NO: { label: "Spar", priceChain: "SPAR_NO" },
  JOKER_NO: { label: "Joker", priceChain: "JOKER_NO" },
  MATKROKEN: { label: "Matkroken", priceChain: "MATKROKEN" },
  NAERBUTIKKEN: { label: "Nærbutikken", priceChain: "NAERBUTIKKEN" },
  ODA_NO: { label: "Oda", priceChain: "ODA_NO" },
  HOLDBART: { label: "Holdbart", priceChain: "HOLDBART" },
  HAVARISTEN: { label: "Havaristen", priceChain: "HAVARISTEN" },
  EUROPRIS_NO: { label: "Europris", priceChain: "EUROPRIS_NO" },
  ENGROSSNETT_NO: { label: "Engrossnett", priceChain: "ENGROSSNETT_NO" },
  FUDI: { label: "Fudi", priceChain: "FUDI" },
};

/**
 * Priskjeder der ett prissett dekker flere butikkformater med reelt ulike
 * priser. Tallene er mer veiledende her, og det skal stå i UI-et.
 */
export const APPROXIMATE_PRICE_CHAINS = new Set(["COOP_NO"]);

/** Sant for koder som dukker opp i prisdata. */
export function isGroceryChain(code) {
  return Object.prototype.hasOwnProperty.call(PRICE_CHAINS, code);
}

/** Sant for fysiske butikker vi vil ha med i en matsammenligning. */
export function isGroceryStoreGroup(group) {
  return Object.prototype.hasOwnProperty.call(STORE_GROUPS, group);
}

/** Oversetter en butikkgruppe til priskjeden prisene ligger under. */
export function priceChainFor(group) {
  return STORE_GROUPS[group]?.priceChain ?? (isGroceryChain(group) ? group : null);
}

/** Navn på en priskjede, f.eks. COOP_NO → "Coop". */
export function chainLabel(code) {
  return PRICE_CHAINS[code]?.label ?? STORE_GROUPS[code]?.label ?? code;
}

/** Navn på et butikkformat, f.eks. COOP_EXTRA → "Coop Extra". */
export function storeGroupLabel(group) {
  return STORE_GROUPS[group]?.label ?? group;
}

/** Kart over priskjede → navn, sendes til frontenden. */
export function chainLabels() {
  return Object.fromEntries(
    Object.entries(PRICE_CHAINS).map(([code, info]) => [code, info.label]),
  );
}

// Beholdt for bakoverkompatibilitet med kode som forventet det gamle navnet.
export const GROCERY_CHAINS = PRICE_CHAINS;
export const GROCERY_CODES = Object.keys(PRICE_CHAINS);
