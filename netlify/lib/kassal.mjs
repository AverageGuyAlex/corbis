/**
 * Alt snakk med Kassalapp går gjennom denne filen.
 *
 * Hvorfor: gratis-tieren tillater 60 kall per minutt. Overskrider vi det får
 * vi 429 og blir stengt ute en stund. Derfor køes alle kall og slippes gjennom
 * med minst MIN_INTERVAL_MS mellomrom, uansett hvor mange steder i koden som
 * ber om data samtidig.
 *
 * Tokenet leses fra miljøvariabelen KASSAL_TOKEN og forlater aldri serveren.
 *
 * Denne filen ligger i netlify/lib/ og ikke i netlify/functions/, fordi
 * Netlify tolker hver fil i functions-mappa som et eget endepunkt.
 */

const BASE = "https://kassal.app/api/v1";

/** 60 kall/min = 1000 ms mellom hvert kall. Vi legger på litt margin. */
export const MIN_INTERVAL_MS = 1100;

/** Hvor mange ganger vi prøver igjen ved 429 eller 5xx. */
const MAX_RETRIES = 3;

let lastCallAt = 0;
let queue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Feil fra Kassalapp, med statuskoden intakt slik at kalleren kan skille
 * mellom "feil token" (401) og "vi kalte for fort" (429).
 */
export class KassalError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "KassalError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Legger en jobb i køen og sørger for at det går minst MIN_INTERVAL_MS
 * mellom hvert faktiske nettverkskall.
 */
function enqueue(job) {
  const result = queue.then(async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return job();
  });

  // Køen må overleve at én jobb feiler, ellers stopper alt som ligger bak.
  queue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

function token() {
  const t = process.env.KASSAL_TOKEN;
  if (!t) {
    throw new KassalError(
      500,
      "KASSAL_TOKEN mangler. Legg den inn under Site configuration → Environment variables i Netlify (eller i .env lokalt).",
    );
  }
  return t;
}

async function request(method, path, { params, body } = {}) {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/json",
    },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await enqueue(() => fetch(url, init));

    if (res.ok) return res.json();

    const shouldRetry = res.status === 429 || res.status >= 500;
    if (!shouldRetry || attempt === MAX_RETRIES) {
      const text = await res.text().catch(() => "");
      throw new KassalError(
        res.status,
        `Kassalapp svarte ${res.status} på ${method} ${path}`,
        text.slice(0, 500),
      );
    }

    // Respekter Retry-After hvis den finnes, ellers eksponentiell backoff.
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : MIN_INTERVAL_MS * 2 ** attempt;
    await sleep(backoff);
  }

  throw new KassalError(500, "Ga opp mot Kassalapp etter flere forsøk");
}

/**
 * Kassalapp svarer i Laravel-stil: { data: [...], links, meta }.
 * Noen endepunkter svarer med objektet direkte. Denne takler begge.
 */
export function unwrap(json) {
  if (json && typeof json === "object" && "data" in json) return json.data;
  return json;
}

export function kassalGet(path, params) {
  return request("GET", path, { params });
}

export function kassalPost(path, body) {
  return request("POST", path, { body });
}

/**
 * Henter flere sider av et paginert endepunkt.
 *
 * Vi følger meta.last_page framfor links.next, fordi vi må bygge URL-en
 * gjennom request() for å beholde kø og retry.
 */
export async function kassalGetAll(path, params, maxPages = 3) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const json = await kassalGet(path, { ...params, page });
    const rows = unwrap(json);
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);

    const lastPage = json?.meta?.last_page;
    if (!lastPage || page >= lastPage) break;
  }
  return all;
}

/** Deler en liste i biter — Kassalapp tar maks 100 strekkoder per bulk-kall. */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
