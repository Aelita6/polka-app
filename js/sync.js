/**
 * Синхронизация полки между устройствами через приватный репозиторий GitHub:
 * файл library.json, доступ по личному токену (Contents: read & write).
 */

const SYNC_KEY = "polka.sync.v1";
const BASE_KEY = "polka.syncBase.v1";
const FILE = "library.json";
export const DEFAULT_REPO = "Aelita6/polka-data";

let fileSha = null;

export function loadSync() {
  try {
    const cfg = JSON.parse(localStorage.getItem(SYNC_KEY) || "null");
    return cfg?.token ? { repo: DEFAULT_REPO, ...cfg } : null;
  } catch {
    return null;
  }
}

export function saveSync(cfg) {
  if (cfg) localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(SYNC_KEY);
}

// savedAt версии, которая последней совпадала на устройстве и в GitHub
export function loadSyncBase() {
  return localStorage.getItem(BASE_KEY) || "";
}

export function saveSyncBase(value) {
  if (value) localStorage.setItem(BASE_KEY, value);
  else localStorage.removeItem(BASE_KEY);
}

function headers(cfg, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${cfg.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function fileUrl(cfg) {
  return `https://api.github.com/repos/${cfg.repo}/contents/${FILE}`;
}

function decodeBase64Utf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function syncError(status, fallback) {
  const messages = {
    401: "ключ доступа неверный или истёк",
    403: "у ключа нет права записи (Contents: Read and write)",
    404: "репозиторий не найден или ключ не даёт к нему доступ",
  };
  const err = new Error(messages[status] || fallback || `ошибка GitHub ${status}`);
  err.status = status;
  return err;
}

export async function checkSyncAccess(cfg) {
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}`, { headers: headers(cfg), cache: "no-store" });
  if (!res.ok) throw syncError(res.status);
  const repo = await res.json();
  if (repo.permissions && !repo.permissions.push) throw syncError(403);
  return repo;
}

// null — файла в репозитории ещё нет
export async function fetchSyncLibrary(cfg) {
  const res = await fetch(fileUrl(cfg), { headers: headers(cfg), cache: "no-store" });
  if (res.status === 404) {
    fileSha = null;
    return null;
  }
  if (!res.ok) throw syncError(res.status);
  const meta = await res.json();
  fileSha = meta.sha;
  let text;
  if (meta.content) {
    text = decodeBase64Utf8(meta.content);
  } else {
    // файлы больше 1 МБ GitHub отдаёт только «сырыми»
    const raw = await fetch(fileUrl(cfg), { headers: headers(cfg, "application/vnd.github.raw+json"), cache: "no-store" });
    if (!raw.ok) throw syncError(raw.status);
    text = await raw.text();
  }
  const data = JSON.parse(text);
  return Array.isArray(data?.books) ? data : null;
}

// true — записано; false — файл успел измениться (нужно перечитать и повторить)
export async function pushSyncLibrary(cfg, payload) {
  const body = {
    message: `Полка: ${payload.books.length} книг, ${payload.savedAt || ""}`,
    content: encodeBase64Utf8(JSON.stringify(payload, null, 1)),
  };
  if (fileSha) body.sha = fileSha;
  const res = await fetch(fileUrl(cfg), {
    method: "PUT",
    headers: { ...headers(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409 || res.status === 422) return false;
  if (!res.ok) throw syncError(res.status);
  fileSha = (await res.json()).content?.sha || null;
  return true;
}

// При равном времени правки побеждает версия из GitHub (b).
function newer(a, b) {
  return (a.updatedAt || a.createdAt || "") > (b.updatedAt || b.createdAt || "") ? a : b;
}

// Объединение двух версий полки: берём все книги, при совпадении — более свежую правку.
export function mergeLibraries(local, remote, isSameBook) {
  const books = [...(remote.books || [])];
  for (const book of local.books || []) {
    const idx = books.findIndex((b) => b.id === book.id || isSameBook(b, book));
    if (idx === -1) books.push(book);
    else books[idx] = newer(book, books[idx]);
  }
  const challenges = [...(remote.challenges || [])];
  for (const ch of local.challenges || []) {
    if (!challenges.some((c) => c.id === ch.id)) challenges.push(ch);
  }
  return {
    books,
    challenges,
    settings: { ...(remote.settings || {}), ...(local.settings || {}) },
    savedAt: new Date().toISOString(),
  };
}

export function syncLinkFor(cfg) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = `sync=${encodeURIComponent(cfg.token)}`;
  return url.toString();
}

// Ключ из ссылки вида …/#sync=TOKEN. Из адреса не убираем: на iPhone иконка «На экран Домой»
// хранит данные отдельно от Safari и должна получить ключ из сохранённой ссылки.
export function takeTokenFromHash() {
  const m = location.hash.match(/(?:^#|&)sync=([^&]+)/);
  return m ? decodeURIComponent(m[1]).trim() : "";
}
