const STATUS_LABELS = {
  reading: "Читаю",
  finished: "Прочитано",
  want: "Хочу прочитать",
  abandoned: "Брошено",
  reread: "Перечитываю",
};

const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export { STATUS_LABELS };

export function filterBooksByYear(books, year) {
  if (year === "all") return books;
  const y = String(year);
  return books.filter((b) => {
    const fin = (b.finishedAt || "").slice(0, 4);
    const start = (b.startedAt || "").slice(0, 4);
    return fin === y || start === y || (!fin && !start && (b.updatedAt || "").slice(0, 4) === y);
  });
}

export function computeKpis(books) {
  const finished = books.filter((b) => b.status === "finished" || b.status === "reread");
  const reading = books.filter((b) => b.status === "reading");
  const pages = finished.reduce((sum, b) => sum + (Number(b.pages) || 0), 0);
  const rated = books.filter((b) => Number(b.rating) > 0);
  const avgRating = rated.length
    ? rated.reduce((s, b) => s + Number(b.rating), 0) / rated.length
    : 0;
  const withNotes = books.filter((b) => (b.notes || "").trim() || (b.review || "").trim()).length;

  return [
    { label: "Всего книг", value: books.length },
    { label: "Прочитано", value: finished.length },
    { label: "Сейчас читаю", value: reading.length },
    { label: "Страниц", value: pages.toLocaleString("ru-RU") },
    { label: "Средняя оценка", value: avgRating ? avgRating.toFixed(1) : "—" },
    { label: "С заметками", value: withNotes },
  ];
}

export function genreDistribution(books) {
  const map = new Map();
  for (const b of books) {
    const genres = Array.isArray(b.genres) && b.genres.length ? b.genres : ["без жанра"];
    for (const g of genres) {
      const key = String(g).trim().toLowerCase();
      if (!key) continue;
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
}

export function pagesByMonth(books, year) {
  const counts = Array(12).fill(0);
  const y = year === "all" ? null : String(year);
  for (const b of books) {
    if (!b.finishedAt || !(Number(b.pages) > 0)) continue;
    if (y && !b.finishedAt.startsWith(y)) continue;
    const month = Number(b.finishedAt.slice(5, 7)) - 1;
    if (month >= 0 && month < 12) counts[month] += Number(b.pages);
  }
  return { labels: MONTHS, values: counts };
}

export function ratingHistogram(books) {
  const buckets = [];
  for (let r = 0; r <= 10; r += 0.5) buckets.push({ rating: r, count: 0 });
  for (const b of books) {
    const rating = Number(b.rating);
    if (!rating && rating !== 0) continue;
    if (rating <= 0) continue;
    const idx = Math.round(rating * 2);
    if (buckets[idx]) buckets[idx].count += 1;
  }
  const filtered = buckets.filter((b) => b.rating > 0);
  return {
    labels: filtered.map((b) => String(b.rating)),
    values: filtered.map((b) => b.count),
  };
}

export function statusDistribution(books) {
  const order = ["finished", "reading", "want", "reread", "abandoned"];
  return order.map((key) => ({
    key,
    label: STATUS_LABELS[key],
    count: books.filter((b) => b.status === key).length,
  }));
}

export function booksPerYear(books) {
  const map = new Map();
  for (const b of books) {
    if (b.status !== "finished" && b.status !== "reread") continue;
    const y = (b.finishedAt || b.updatedAt || "").slice(0, 4);
    if (!/^\d{4}$/.test(y)) continue;
    map.set(y, (map.get(y) || 0) + 1);
  }
  const entries = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return { labels: entries.map((e) => e[0]), values: entries.map((e) => e[1]) };
}

export function topAuthors(books, limit = 8) {
  const map = new Map();
  for (const b of books) {
    const author = (b.author || "Неизвестный").trim();
    map.set(author, (map.get(author) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

export function availableYears(books) {
  const set = new Set();
  for (const b of books) {
    for (const d of [b.finishedAt, b.startedAt, b.createdAt]) {
      const y = (d || "").slice(0, 4);
      if (/^\d{4}$/.test(y)) set.add(y);
    }
  }
  return [...set].sort((a, b) => b.localeCompare(a));
}

export function challengeProgress(challenge, books) {
  const from = challenge.from;
  const to = challenge.to;
  const inRange = (b) => {
    const d = b.finishedAt || b.updatedAt || "";
    if (!d) return false;
    const day = d.slice(0, 10);
    return day >= from && day <= to;
  };

  const finished = books.filter(
    (b) => (b.status === "finished" || b.status === "reread") && inRange(b),
  );

  let current = 0;
  if (challenge.type === "books") {
    current = finished.length;
  } else if (challenge.type === "pages") {
    current = finished.reduce((s, b) => s + (Number(b.pages) || 0), 0);
  } else if (challenge.type === "genre") {
    const g = (challenge.genre || "").toLowerCase().trim();
    current = finished.filter((b) =>
      (b.genres || []).some((x) => String(x).toLowerCase().includes(g)),
    ).length;
  } else if (challenge.type === "rating") {
    const rated = finished.filter((b) => Number(b.rating) > 0);
    current = rated.length
      ? rated.reduce((s, b) => s + Number(b.rating), 0) / rated.length
      : 0;
  }

  const target = Number(challenge.target) || 1;
  const pct = Math.min(100, Math.round((current / target) * 1000) / 10);
  return { current, target, pct, done: current >= target };
}

export function collectGenres(books) {
  const set = new Set();
  for (const b of books) {
    for (const g of b.genres || []) {
      const t = String(g).trim();
      if (t) set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ru"));
}

export function parseList(str) {
  return String(str || "")
    .split(/[,;|/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
