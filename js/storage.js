const STORAGE_KEY = "polka.library.v1";
const CHALLENGES_KEY = "polka.challenges.v1";
const SETTINGS_KEY = "polka.settings.v1";

const defaultSettings = {
  layout: "grid",
  demoLoaded: false,
};

export function uid() {
  return crypto.randomUUID?.() || `id_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function loadBooks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveBooks(books) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
}

export function loadChallenges() {
  try {
    const raw = localStorage.getItem(CHALLENGES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveChallenges(challenges) {
  localStorage.setItem(CHALLENGES_KEY, JSON.stringify(challenges));
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

const SAVED_AT_KEY = "polka.savedAt.v1";

export function loadSavedAt() {
  return localStorage.getItem(SAVED_AT_KEY) || "";
}

export function saveSavedAt(value) {
  localStorage.setItem(SAVED_AT_KEY, value);
}

// undefined — сервера нет (статичный хостинг), null — на сервере пока пусто
export async function fetchServerLibrary() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch("/api/library", { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return undefined;
    const data = await res.json();
    return data.ok ? data.library : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function pushServerLibrary(payload, force = false) {
  const res = await fetch(`/api/library${force ? "?force=1" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

export function exportData(books, challenges, settings) {
  return {
    app: "Полка",
    version: 1,
    exportedAt: new Date().toISOString(),
    books,
    challenges,
    settings,
  };
}

export function importData(payload) {
  if (!payload || !Array.isArray(payload.books)) {
    throw new Error("Неверный формат файла");
  }
  return {
    mode: payload.mode === "merge" ? "merge" : "replace",
    books: payload.books,
    challenges: Array.isArray(payload.challenges) ? payload.challenges : [],
    settings: payload.settings ? { ...defaultSettings, ...payload.settings } : loadSettings(),
  };
}

function normWords(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function isSameBook(a, b) {
  if (normWords(a.title).join(" ") !== normWords(b.title).join(" ")) return false;
  const sa = normWords(a.author).pop();
  const sb = normWords(b.author).pop();
  if (!sa || !sb) return true;
  return sa.slice(0, 5) === sb.slice(0, 5);
}

// Демо-книга считается нетронутой, пока её заметки совпадают с исходными.
export function isDemoBook(book) {
  return createDemoBooks().some(
    (d) => d.title === book.title && d.author === book.author && d.notes === (book.notes || ""),
  );
}

const REFRESH_FIELDS = ["cover", "rating", "finishedAt", "pages", "year", "publisher", "isbn", "author", "genres", "tags"];

function isEmptyValue(v) {
  return v === undefined || v === null || v === "" || v === 0 || (Array.isArray(v) && !v.length);
}

// LiveLib по адресу /o/ отдаёт серую заглушку вместо обложки
function isBrokenCover(url) {
  return /livelib\.ru\/boocover\/\d+\/o\//.test(url || "");
}

export function mergeBooks(existing, incoming) {
  const kept = existing.filter((b) => !isDemoBook(b));
  const removedDemo = existing.length - kept.length;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const book of incoming) {
    const match = kept.find((b) => isSameBook(b, book));
    if (!match) {
      kept.push({ ...book, id: book.id || uid() });
      added += 1;
      continue;
    }
    // Книги, которые после импорта не редактировали, обновляем целиком;
    // в отредактированных заполняем только пустые поля.
    const untouched = match.updatedAt && match.updatedAt === match.createdAt;
    let changed = false;
    for (const field of REFRESH_FIELDS) {
      const next = book[field];
      if (isEmptyValue(next)) continue;
      const replace = untouched
        || isEmptyValue(match[field])
        || (field === "cover" && isBrokenCover(match.cover));
      if (replace && JSON.stringify(match[field]) !== JSON.stringify(next)) {
        match[field] = next;
        changed = true;
      }
    }
    if (changed) updated += 1;
    else skipped += 1;
  }
  return { books: kept, added, updated, skipped, removedDemo };
}

export function createDemoBooks() {
  const year = new Date().getFullYear();
  return [
    {
      id: uid(),
      title: "Мастер и Маргарита",
      author: "Михаил Булгаков",
      genres: ["классика", "мистика", "сатира"],
      pages: 480,
      year: 1967,
      isbn: "",
      language: "русский",
      publisher: "Художественная литература",
      status: "finished",
      rating: 10,
      cover: "https://covers.openlibrary.org/b/id/12947486-L.jpg",
      startedAt: `${year}-01-05`,
      finishedAt: `${year}-01-28`,
      review: "Безупречный баланс сатиры и мистики.",
      notes: "«Рукописи не горят.»\nПеречитывать раз в несколько лет — обязательно.",
      tags: ["любимое", "классика"],
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
    {
      id: uid(),
      title: "Пикник на обочине",
      author: "Аркадий и Борис Стругацкие",
      genres: ["фантастика", "софт-SF"],
      pages: 224,
      year: 1972,
      isbn: "",
      language: "русский",
      publisher: "АСТ",
      status: "finished",
      rating: 9.5,
      cover: "https://covers.openlibrary.org/b/id/15232314-L.jpg",
      startedAt: `${year}-02-10`,
      finishedAt: `${year}-02-18`,
      review: "Зона как зеркало человеческой алчности.",
      notes: "Сталкеры, артефакты, моральный выбор — основа всего последующего киберпанка.",
      tags: ["SF", "СССР"],
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
    {
      id: uid(),
      title: "Норвежский лес",
      author: "Харуки Мураками",
      genres: ["современная проза", "роман"],
      pages: 384,
      year: 1987,
      isbn: "",
      language: "перевод",
      publisher: "Эксмо",
      status: "reading",
      rating: 8,
      cover: "https://covers.openlibrary.org/b/isbn/9780099448822-L.jpg",
      startedAt: `${year}-03-01`,
      finishedAt: "",
      review: "",
      notes: "Атмосфера тоски и студенческой юности. Музыка на каждой странице.",
      tags: ["япония"],
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
    {
      id: uid(),
      title: "Трудно быть богом",
      author: "Аркадий и Борис Стругацкие",
      genres: ["фантастика"],
      pages: 256,
      year: 1964,
      isbn: "",
      language: "русский",
      publisher: "",
      status: "want",
      rating: 0,
      cover: "",
      startedAt: "",
      finishedAt: "",
      review: "",
      notes: "",
      tags: ["wishlist"],
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
  ];
}

export function createDemoChallenges() {
  const year = new Date().getFullYear();
  return [
    {
      id: uid(),
      title: `${year}: 24 книги`,
      type: "books",
      target: 24,
      genre: "",
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      createdAt: new Date().toISOString(),
    },
    {
      id: uid(),
      title: "10 000 страниц за год",
      type: "pages",
      target: 10000,
      genre: "",
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      createdAt: new Date().toISOString(),
    },
    {
      id: uid(),
      title: "Фантастика × 6",
      type: "genre",
      target: 6,
      genre: "фантастика",
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      createdAt: new Date().toISOString(),
    },
  ];
}
