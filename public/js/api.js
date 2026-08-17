/**
 * Klient mot appens egne /api/*-funksjoner.
 *
 * Nettleseren snakker aldri direkte med Kassalapp. Tokenet ligger som
 * miljøvariabel på serveren og skal aldri havne i noe som lastes ned hit —
 * både av sikkerhetsgrunner og fordi API-vilkårene krever det.
 */

const KEY_STORAGE = "corbis.key";

export class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
  get isAuth() {
    return this.status === 401;
  }
}

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setKey(value) {
  try {
    localStorage.setItem(KEY_STORAGE, value);
  } catch {
    /* privat modus — appen virker, men passordet må skrives inn på nytt */
  }
}

export function clearKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {}
}

async function call(path, { method = "GET", body, params } = {}) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const headers = { "x-corbis-key": getKey() };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Ingen nettforbindelse.");
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* tomt svar er greit, f.eks. 204 */
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Serveren svarte ${res.status}.`, data?.detail);
  }
  return data;
}

export const api = {
  getList: () => call("/api/list"),
  putList: (list) => call("/api/list", { method: "PUT", body: list }),

  getStores: () => call("/api/stores"),
  findNearby: ({ lat, lng, km }) => call("/api/stores", { params: { nearby: 1, lat, lng, km } }),
  putStores: (payload) => call("/api/stores", { method: "PUT", body: payload }),

  search: ({ q, include, exclude, categoryId, pages }) =>
    call("/api/search", {
      params: {
        q,
        include: include?.length ? include.join(",") : undefined,
        exclude: exclude?.length ? exclude.join(",") : undefined,
        categoryId,
        pages,
      },
    }),
  lookupEan: (ean) => call("/api/search", { params: { ean } }),

  getPrices: () => call("/api/prices"),
  rebuildPrices: ({ force } = {}) =>
    call("/api/prices", { method: "POST", params: force ? { force: 1 } : undefined }),

  getCandidates: () => call("/api/candidates"),
  decide: ({ itemId, approve, reject }) =>
    call("/api/candidates", { method: "POST", body: { itemId, approve, reject } }),
};
