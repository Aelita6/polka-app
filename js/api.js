/**
 * Поиск книг: сначала локальный /api/search (Fantlab, LiveLib, OL, Google…),
 * при отсутствии сервера — прямые запросы к открытым каталогам.
 */

const GOOGLE_KEY_STORAGE = "polka.googleBooksKey";

export function getGoogleApiKey() {
  return localStorage.getItem(GOOGLE_KEY_STORAGE) || "";
}

export function setGoogleApiKey(key) {
  if (key) localStorage.setItem(GOOGLE_KEY_STORAGE, key.trim());
  else localStorage.removeItem(GOOGLE_KEY_STORAGE);
}

export const SOURCE_LABELS = {
  fantlab: "Fantlab",
  livelib: "LiveLib",
  openlibrary: "OL",
  google: "Google",
  wikidata: "Wikidata",
};

function pickCoverFromGoogle(volumeInfo) {
  const links = volumeInfo.imageLinks || {};
  const url = links.extraLarge || links.large || links.medium || links.thumbnail || links.smallThumbnail || "";
  return url.replace("http://", "https://").replace("&edge=curl", "");
}

function mapLang(code) {
  const map = {
    ru: "русский",
    en: "английский",
    de: "немецкий",
    fr: "французский",
    es: "испанский",
    it: "итальянский",
    ja: "японский",
    zh: "китайский",
  };
  return map[code] || code || "русский";
}

function normalizeGoogleItem(item) {
  const v = item.volumeInfo || {};
  const industry = (v.industryIdentifiers || []).find((x) => x.type === "ISBN_13")
    || (v.industryIdentifiers || []).find((x) => x.type === "ISBN_10");
  return {
    source: "google",
    title: v.title || "Без названия",
    author: (v.authors || []).join(", ") || "Неизвестный автор",
    pages: v.pageCount || null,
    year: v.publishedDate ? parseInt(String(v.publishedDate).slice(0, 4), 10) : null,
    isbn: industry?.identifier || "",
    language: mapLang(v.language),
    publisher: v.publisher || "",
    cover: pickCoverFromGoogle(v),
    genres: (v.categories || []).slice(0, 4),
    description: v.description || "",
  };
}

function normalizeOpenLibraryDoc(doc) {
  const isbn = (doc.isbn || []).find((x) => x && String(x).replace(/\D/g, "").length >= 10) || "";
  const cover = doc.cover_i
    ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
    : isbn
      ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`
      : "";
  const subjects = (doc.subject || [])
    .map((s) => String(s).toLowerCase())
    .filter((s) => s.length < 40)
    .slice(0, 4);

  return {
    source: "openlibrary",
    title: doc.title || "Без названия",
    author: (doc.author_name || []).join(", ") || "Неизвестный автор",
    pages: doc.number_of_pages_median || null,
    year: doc.first_publish_year || null,
    isbn,
    language: "русский",
    publisher: (doc.publisher || [])[0] || "",
    cover,
    genres: subjects,
    description: "",
  };
}

function isDuplicate(a, b) {
  const ta = a.title.toLowerCase().trim();
  const tb = b.title.toLowerCase().trim();
  const aa = (a.author.split(",")[0] || "").toLowerCase().trim();
  const ba = (b.author.split(",")[0] || "").toLowerCase().trim();
  return ta === tb && (aa.includes(ba) || ba.includes(aa) || !aa || !ba);
}

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (data.error && !data.items && !data.docs) {
    const err = new Error(data.error.message || data.error || "API error");
    err.status = 429;
    throw err;
  }
  return data;
}

let googleDisabledUntil = 0;

async function searchGoogleBooks(query) {
  if (Date.now() < googleDisabledUntil) return [];

  const key = getGoogleApiKey();
  const keyParam = key ? `&key=${encodeURIComponent(key)}` : "";
  const variants = [
    query,
    `${query} inpublisher:АСТ`,
    `${query} inpublisher:Эксмо`,
    `${query} inpublisher:Азбука`,
  ];

  const results = [];
  for (const variant of variants) {
    const encoded = encodeURIComponent(variant);
    const urls = [
      `https://www.googleapis.com/books/v1/volumes?q=${encoded}&maxResults=8&langRestrict=ru&printType=books${keyParam}`,
      `https://www.googleapis.com/books/v1/volumes?q=${encoded}&maxResults=6&printType=books${keyParam}`,
    ];
    for (const url of urls) {
      try {
        const data = await fetchJson(url);
        if (data.items?.length) {
          for (const item of data.items.map(normalizeGoogleItem)) {
            if (!results.some((r) => isDuplicate(r, item))) results.push(item);
          }
        }
      } catch (e) {
        if (e.status === 429 || e.status === 403) {
          googleDisabledUntil = Date.now() + 30 * 60 * 1000;
          return results;
        }
      }
    }
    if (results.length >= 10) break;
  }
  return results;
}

async function searchOpenLibrary(query) {
  const encoded = encodeURIComponent(query);
  const urls = [
    `https://openlibrary.org/search.json?q=${encoded}&limit=10&language=rus`,
    `https://openlibrary.org/search.json?q=${encoded}&limit=10`,
    `https://openlibrary.org/search.json?title=${encoded}&limit=8&language=rus`,
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query + " АСТ")}&limit=5&language=rus`,
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query + " Эксмо")}&limit=5&language=rus`,
  ];
  const settled = await Promise.allSettled(urls.map((url) => fetchJson(url)));
  const docs = [];
  const seen = new Set();
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value?.docs?.length) continue;
    for (const doc of s.value.docs) {
      const key = doc.key || `${doc.title}-${(doc.author_name || [])[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push(doc);
    }
  }
  return docs.map(normalizeOpenLibraryDoc);
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function fantlabEdition(edId) {
  try {
    const ed = await fetchJson(`https://api.fantlab.ru/edition/${edId}`);
    const image = ed.image ? (String(ed.image).startsWith("/") ? `https://fantlab.ru${ed.image}` : ed.image) : "";
    return {
      pages: ed.pages || null,
      isbn: (ed.isbns || [])[0] || "",
      publisher: clean(ed.creators?.publishers?.[0]?.name),
      year: parseInt(ed.year, 10) || null,
      cover: image,
    };
  } catch {
    return {};
  }
}

async function searchFantlab(query) {
  const data = await fetchJson(`https://api.fantlab.ru/search-works?q=${encodeURIComponent(query)}&page=1`);
  const matches = (data.matches || []).slice(0, 10);
  return Promise.all(matches.map(async (m) => {
    const edId = m.pic_edition_id_auto || m.pic_edition_id;
    const ed = edId ? await fantlabEdition(edId) : {};
    return {
      source: "fantlab",
      title: clean(m.rusname || m.name || m.name_show_im || m.fullname) || "Без названия",
      author: clean(m.all_autor_rusname || m.autor_rusname || m.autor1_rusname) || "Неизвестный автор",
      pages: ed.pages || null,
      year: parseInt(m.year, 10) || ed.year || null,
      isbn: ed.isbn || "",
      language: "русский",
      publisher: ed.publisher || "",
      cover: ed.cover || (edId ? `https://fantlab.ru/images/editions/big/${edId}` : ""),
      genres: [],
      description: "",
      url: m.work_id ? `https://fantlab.ru/work${m.work_id}` : "",
    };
  }));
}

async function searchViaLocalApi(query) {
  const url = `/api/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`local api ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "search failed");
  return Array.isArray(data.items) ? data.items : [];
}

export async function loadPublishers() {
  try {
    const res = await fetch("/api/publishers");
    if (res.ok) {
      const data = await res.json();
      if (data.items?.length) return data.items;
    }
  } catch {
    /* статичный хостинг — берём список из файла */
  }
  try {
    const res = await fetch(new URL("./publishers.json", import.meta.url));
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

export async function searchBooks(query) {
  const q = query.trim();
  if (!q) return [];

  // 1) Prefer local Python API (Fantlab + LiveLib + …)
  try {
    const local = await searchViaLocalApi(q);
    if (local.length) return local.slice(0, 24);
  } catch {
    /* fallback to browser-direct catalogs */
  }

  const [fantlab, ol, google] = await Promise.all([
    searchFantlab(q).catch(() => []),
    searchOpenLibrary(q).catch(() => []),
    searchGoogleBooks(q).catch(() => []),
  ]);

  const results = [];
  for (const item of [...fantlab, ...google, ...ol]) {
    if (!results.some((r) => isDuplicate(r, item))) results.push(item);
  }

  if (!results.length) {
    throw new Error("Ничего не найдено. Попробуйте другое написание или ISBN.");
  }

  return results.slice(0, 24);
}

export async function enrichCover(book) {
  if (book.cover) return book.cover;
  if (book.isbn) {
    return `https://covers.openlibrary.org/b/isbn/${book.isbn.replace(/[^0-9Xx]/g, "")}-L.jpg`;
  }
  return "";
}
