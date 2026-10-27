import {
  loadBooks,
  saveBooks,
  loadChallenges,
  saveChallenges,
  loadSettings,
  saveSettings,
  exportData,
  importData,
  mergeBooks,
  isDemoBook,
  isSameBook,
  loadSavedAt,
  saveSavedAt,
  fetchServerLibrary,
  pushServerLibrary,
  createDemoBooks,
  createDemoChallenges,
  uid,
} from "./storage.js?v=20261027b";
import { searchBooks, loadPublishers, SOURCE_LABELS } from "./api.js?v=20261027b";
import {
  DEFAULT_REPO,
  loadSync,
  saveSync,
  loadSyncBase,
  saveSyncBase,
  checkSyncAccess,
  fetchSyncLibrary,
  pushSyncLibrary,
  mergeLibraries,
  syncLinkFor,
  takeTokenFromHash,
} from "./sync.js?v=20261027b";
import {
  STATUS_LABELS,
  MONTH_NAMES,
  bookDate,
  filterBooksByPeriod,
  monthCounts,
  monthlyActivity,
  computeKpis,
  genreDistribution,
  ratingHistogram,
  statusDistribution,
  booksPerYear,
  topAuthors,
  availableYears,
  challengeProgress,
  collectGenres,
  parseList,
} from "./stats.js?v=20261027b";

const state = {
  books: [],
  challenges: [],
  settings: loadSettings(),
  editingId: null,
  layout: "grid",
  charts: {},
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRating(r) {
  const n = Number(r);
  if (!n) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function saveLocal(savedAt) {
  saveBooks(state.books);
  saveChallenges(state.challenges);
  saveSettings(state.settings);
  saveSavedAt(savedAt);
}

let pushTimer = null;
let pushForce = false;
let serverAvailable = false;
// "server" — Python-сервер Полки, "github" — синхронизация через приватный репозиторий
let remoteKind = null;
let syncCfg = loadSync();
let syncing = false;
let syncAgain = false;

function currentPayload() {
  return {
    books: state.books,
    challenges: state.challenges,
    settings: state.settings,
    savedAt: loadSavedAt(),
  };
}

function persist({ force = false } = {}) {
  saveLocal(new Date().toISOString());
  if (!remoteKind) return;
  pushForce = pushForce || force;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushRemote, remoteKind === "github" ? 1500 : 500);
}

function pushRemote() {
  pushTimer = null;
  const force = pushForce;
  pushForce = false;
  return remoteKind === "github" ? pushToGithub(force) : pushToServer(force);
}

function setSyncStatus(kind, text) {
  const btn = $("#btn-sync");
  if (!btn) return;
  btn.dataset.state = kind;
  btn.title = text || "Синхронизация iPhone ↔ Mac";
}

async function pushToGithub(force) {
  if (syncing) {
    syncAgain = true;
    pushForce = pushForce || force;
    return;
  }
  syncing = true;
  setSyncStatus("busy", "Сохраняю в GitHub…");
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remote = await fetchSyncLibrary(syncCfg);
      let payload = currentPayload();
      if (!force && remote?.books?.length) {
        if (remote.books.length >= 10 && payload.books.length < remote.books.length * 0.5) {
          adoptLibrary(remote);
          saveSyncBase(remote.savedAt);
          renderLibrary();
          toast(`В GitHub полка больше (${remote.books.length} книг) — загрузил её`);
          setSyncStatus("ok", "Синхронизировано");
          return;
        }
        if ((remote.savedAt || "") > loadSyncBase()) {
          payload = mergeLibraries(payload, remote, isSameBook);
          adoptLibrary(payload);
          renderLibrary();
        }
      }
      if (await pushSyncLibrary(syncCfg, payload)) {
        saveSyncBase(payload.savedAt);
        setSyncStatus("ok", `Синхронизировано: ${payload.books.length} книг`);
        return;
      }
    }
    setSyncStatus("error", "Не удалось сохранить в GitHub");
    toast("Не удалось сохранить в GitHub — изменения остались в браузере");
  } catch (e) {
    setSyncStatus("error", `Синхронизация: ${e.message}`);
    toast(`Синхронизация: ${e.message}. Изменения остались в браузере`);
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushRemote, 500);
    }
  }
}

// Сводим полку браузера с версией из GitHub при открытии и возвращении на вкладку.
function reconcileWithRemote(remote) {
  const base = loadSyncBase();
  const localIsEmpty = !state.books.length || onlyDemo(state.books);
  if (!remote?.books?.length) {
    persist();
    return false;
  }
  const remoteChanged = (remote.savedAt || "") > base;
  const localChanged = loadSavedAt() > base;
  if (localIsEmpty || (remoteChanged && !localChanged)) {
    adoptLibrary(remote);
    saveSyncBase(remote.savedAt);
    return true;
  }
  if (remoteChanged) {
    adoptLibrary(mergeLibraries(currentPayload(), remote, isSameBook));
    persist();
    return true;
  }
  if (localChanged) persist();
  return false;
}

async function pushToServer(force) {
  const payload = currentPayload();
  try {
    const { status, data } = await pushServerLibrary(payload, force);
    if (status === 409 && data.server) {
      adoptLibrary(data.server);
      renderLibrary();
      toast(`На сервере полка больше (${data.server.books.length} книг) — загрузил её`);
    } else if (status !== 200) {
      toast("Не удалось сохранить на сервер — изменения остались в браузере");
    }
  } catch {
    toast("Нет связи с сервером — изменения остались в браузере");
  }
}

function adoptLibrary(lib) {
  state.books = lib.books || [];
  state.challenges = lib.challenges || [];
  state.settings = { ...state.settings, ...(lib.settings || {}), demoLoaded: true };
  state.layout = state.settings.layout || "grid";
  saveLocal(lib.savedAt || new Date().toISOString());
}

function onlyDemo(books) {
  return books.length > 0 && books.every(isDemoBook);
}

async function initData() {
  state.books = loadBooks();
  state.challenges = loadChallenges();
  state.settings = loadSettings();
  state.layout = state.settings.layout || "grid";

  const server = await fetchServerLibrary();
  serverAvailable = server !== undefined;
  if (serverAvailable) remoteKind = "server";
  const localSavedAt = loadSavedAt();

  if (!serverAvailable) {
    if (!state.settings.demoLoaded && state.books.length === 0) {
      state.books = createDemoBooks();
      state.challenges = createDemoChallenges();
      state.settings.demoLoaded = true;
      saveLocal("");
    }
    if (syncCfg) {
      try {
        const remote = await fetchSyncLibrary(syncCfg);
        remoteKind = "github";
        reconcileWithRemote(remote);
        setSyncStatus("ok", "Синхронизировано");
      } catch (e) {
        setSyncStatus("error", `Синхронизация: ${e.message}`);
        toast(`Синхронизация: ${e.message}`);
      }
    }
    return;
  }

  if (server && server.books?.length) {
    const localIsEmpty = !state.books.length || onlyDemo(state.books);
    if (localIsEmpty || !localSavedAt || (server.savedAt || "") >= localSavedAt) {
      adoptLibrary(server);
    } else {
      persist();
    }
    return;
  }

  if (!state.settings.demoLoaded && state.books.length === 0) {
    state.books = createDemoBooks();
    state.challenges = createDemoChallenges();
    state.settings.demoLoaded = true;
  }
  persist();
}

async function refreshFromServer() {
  if (!serverAvailable) {
    if (!syncCfg || pushTimer || syncing) return;
    try {
      const remote = await fetchSyncLibrary(syncCfg);
      remoteKind = "github";
      if (reconcileWithRemote(remote)) renderLibrary();
      setSyncStatus("ok", "Синхронизировано");
    } catch (e) {
      setSyncStatus("error", `Синхронизация: ${e.message}`);
    }
    return;
  }
  if (pushTimer && pushForce) return;
  const server = await fetchServerLibrary();
  if (server?.books?.length && (server.savedAt || "") > loadSavedAt()) {
    adoptLibrary(server);
    renderLibrary();
  }
}

/* ---------- Navigation ---------- */
function setView(name) {
  $$(".view").forEach((v) => v.classList.remove("active"));
  $$(".nav-btn").forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  $(`#view-${name}`)?.classList.add("active");
  if (name === "stats") renderStats();
  if (name === "challenges") renderChallenges();
  if (name === "notes") renderNotes();
}

/* ---------- Library ---------- */
function getFilteredBooks() {
  const q = ($("#library-search").value || "").trim().toLowerCase();
  const status = $("#filter-status").value;
  const genre = $("#filter-genre").value;
  const year = $("#filter-year").value;
  const month = $("#filter-month").value;
  const sort = $("#sort-by").value;

  let list = [...state.books];
  if (status !== "all") list = list.filter((b) => b.status === status);
  list = filterBooksByPeriod(list, year, month);
  if (genre !== "all") {
    list = list.filter((b) =>
      (b.genres || []).some((g) => g.toLowerCase() === genre.toLowerCase()),
    );
  }
  if (q) {
    list = list.filter((b) => {
      const hay = [b.title, b.author, ...(b.genres || []), ...(b.tags || []), b.notes, b.review]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  const sorters = {
    title: (a, b) => a.title.localeCompare(b.title, "ru"),
    author: (a, b) => a.author.localeCompare(b.author, "ru"),
    rating: (a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0),
    pages: (a, b) => (Number(b.pages) || 0) - (Number(a.pages) || 0),
    finishedAt: (a, b) => bookDate(b).localeCompare(bookDate(a)),
    year: (a, b) => (Number(b.year) || 0) - (Number(a.year) || 0),
    updated: (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  };
  list.sort(sorters[sort] || sorters.updated);
  return list;
}

function renderGenreFilter() {
  const select = $("#filter-genre");
  const current = select.value;
  const genres = collectGenres(state.books);
  select.innerHTML = `<option value="all">Все жанры</option>`
    + genres.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function fillPeriodSelects(yearSel, monthSel, books) {
  const currentYear = yearSel.value || "all";
  const yearCounts = new Map();
  for (const b of books) {
    const y = bookDate(b).slice(0, 4);
    if (/^\d{4}$/.test(y)) yearCounts.set(y, (yearCounts.get(y) || 0) + 1);
  }
  const years = [...yearCounts.keys()].sort((a, b) => b.localeCompare(a));
  yearSel.innerHTML = `<option value="all">Все годы</option>`
    + years.map((y) => `<option value="${y}">${y} · ${yearCounts.get(y)}</option>`).join("");
  yearSel.value = years.includes(currentYear) ? currentYear : "all";

  const currentMonth = monthSel.value || "all";
  const counts = monthCounts(books, yearSel.value);
  monthSel.innerHTML = `<option value="all">Все месяцы</option>`
    + MONTH_NAMES.map((name, i) => {
      const key = String(i + 1).padStart(2, "0");
      const n = counts.get(key) || 0;
      return `<option value="${key}"${n ? "" : " disabled"}>${name}${n ? ` · ${n}` : ""}</option>`;
    }).join("");
  monthSel.value = counts.get(currentMonth) ? currentMonth : "all";
}

function renderYearFilter() {
  fillPeriodSelects($("#filter-year"), $("#filter-month"), state.books);
}

function pluralBooks(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "книга";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "книги";
  return "книг";
}

function periodLabel(year, month) {
  if (year === "all" && month === "all") return "";
  const m = month === "all" ? "" : MONTH_NAMES[Number(month) - 1];
  if (year === "all") return `${m}, все годы`;
  return m ? `${m} ${year}` : `${year} год`;
}

function renderPeriodSummary(list) {
  const box = $("#period-summary");
  const label = periodLabel($("#filter-year").value, $("#filter-month").value);
  box.classList.toggle("hidden", !label);
  if (!label) return;
  const read = list.filter((b) => b.status === "finished" || b.status === "reread");
  const pages = read.reduce((s, b) => s + (Number(b.pages) || 0), 0);
  $("#period-text").textContent = `${label}: ${list.length} ${pluralBooks(list.length)}`
    + (read.length ? ` · прочитано ${read.length}` : "")
    + (pages ? ` · ${pages.toLocaleString("ru-RU")} стр.` : "");
}

function resetPeriod() {
  $("#filter-year").value = "all";
  $("#filter-month").value = "all";
  renderLibrary();
}

function coverHtml(book, className = "cover") {
  const fallback = `<div class="cover-fallback">${escapeHtml(book.title)}</div>`;
  if (book.cover) {
    return `<div class="${className}"><img src="${escapeHtml(book.cover)}" alt="" loading="lazy" data-fallback="1" /><noscript>${fallback}</noscript></div>`;
  }
  return `<div class="${className}">${fallback}</div>`;
}

function bindCoverFallbacks(root = document) {
  $$("img[data-fallback]", root).forEach((img) => {
    const showFallback = () => {
      const parent = img.parentElement;
      if (!parent) return;
      const title = parent.closest("[data-id]")?.querySelector(".title")?.textContent
        || parent.closest(".detail-layout")?.querySelector("h2")?.textContent
        || "Книга";
      parent.innerHTML = `<div class="cover-fallback">${escapeHtml(title)}</div>`;
    };
    img.addEventListener("error", showFallback, { once: true });
    // Каталоги иногда отдают вместо обложки крошечную заглушку
    img.addEventListener("load", () => {
      if (img.naturalWidth < 40) showFallback();
    }, { once: true });
  });
}

function renderLibrary() {
  renderGenreFilter();
  renderYearFilter();
  const list = getFilteredBooks();
  renderPeriodSummary(list);
  const grid = $("#library-grid");
  const empty = $("#library-empty");
  grid.classList.toggle("list", state.layout === "list");
  $$(".view-toggle .icon-btn").forEach((b) => {
    const on = b.dataset.layout === state.layout;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });

  if (!state.books.length) {
    empty.classList.remove("hidden");
    grid.innerHTML = "";
    return;
  }
  empty.classList.add("hidden");

  if (!list.length) {
    grid.innerHTML = `<div class="empty-state"><p class="empty-title">Ничего не найдено</p><p class="empty-text">Попробуйте другой фильтр или запрос.</p></div>`;
    return;
  }

  grid.innerHTML = list.map((b, i) => `
    <button type="button" class="book-card" data-id="${b.id}" style="animation-delay:${Math.min(i, 12) * 40}ms">
      ${coverHtml(b)}
      <div class="meta">
        <h3 class="title">${escapeHtml(b.title)}</h3>
        <p class="author">${escapeHtml(b.author)}</p>
        <div class="badges">
          <span class="badge status-${escapeHtml(b.status)}">${STATUS_LABELS[b.status] || b.status}</span>
          ${Number(b.rating) > 0 ? `<span class="badge rating">★ ${formatRating(b.rating)}</span>` : ""}
          ${b.pages ? `<span class="badge">${Number(b.pages).toLocaleString("ru-RU")} стр.</span>` : ""}
        </div>
      </div>
    </button>
  `).join("");
  bindCoverFallbacks(grid);
}

/* ---------- Book modal ---------- */
function openBookModal(book = null) {
  state.editingId = book?.id || null;
  $("#modal-title").textContent = book ? "Редактировать книгу" : "Новая книга";
  $("#btn-delete").classList.toggle("hidden", !book);
  $("#field-id").value = book?.id || "";
  $("#field-title").value = book?.title || "";
  $("#field-author").value = book?.author || "";
  $("#field-genres").value = (book?.genres || []).join(", ");
  $("#field-language").value = book?.language || "русский";
  $("#field-pages").value = book?.pages || "";
  $("#field-year").value = book?.year || "";
  $("#field-isbn").value = book?.isbn || "";
  $("#field-status").value = book?.status || "want";
  $("#field-started").value = book?.startedAt || "";
  $("#field-finished").value = book?.finishedAt || "";
  $("#field-rating").value = book?.rating || 0;
  $("#field-publisher").value = book?.publisher || "";
  $("#field-review").value = book?.review || "";
  $("#field-notes").value = book?.notes || "";
  $("#field-tags").value = (book?.tags || []).join(", ");
  $("#field-cover").value = book?.cover || "";
  $("#lookup-query").value = "";
  $("#lookup-results").innerHTML = "";
  updateRatingOutput();
  updateCoverPreview();
  $("#book-modal").showModal();
  $("#field-title").focus();
}

function updateRatingOutput() {
  const v = Number($("#field-rating").value);
  $("#rating-output").textContent = v > 0 ? formatRating(v) : "—";
}

function updateCoverPreview() {
  const url = $("#field-cover").value.trim();
  const box = $("#cover-preview");
  if (url) {
    box.innerHTML = `<img src="${escapeHtml(url)}" alt="" onerror="this.parentElement.innerHTML='<span>Нет изображения</span>'" />`;
  } else {
    box.innerHTML = "<span>Обложка</span>";
  }
}

function fillFromLookup(item) {
  $("#field-title").value = item.title || "";
  $("#field-author").value = item.author || "";
  if (item.pages) $("#field-pages").value = item.pages;
  if (item.year) $("#field-year").value = item.year;
  if (item.isbn) $("#field-isbn").value = item.isbn;
  if (item.language) $("#field-language").value = item.language;
  if (item.publisher) $("#field-publisher").value = item.publisher;
  if (item.cover) $("#field-cover").value = item.cover;
  if (item.genres?.length) $("#field-genres").value = item.genres.join(", ");
  if (item.description && !$("#field-review").value) {
    $("#field-review").value = item.description.slice(0, 400);
  }
  updateCoverPreview();
  const src = SOURCE_LABELS[item.source] || item.source || "каталог";
  toast(`Данные из ${src}`);
}

async function runLookup() {
  const q = $("#lookup-query").value.trim();
  if (!q) return toast("Введите запрос");
  const box = $("#lookup-results");
  box.innerHTML = `<p style="color:var(--text-muted);margin:0;font-size:0.9rem">Ищем в каталогах…</p>`;
  try {
    const items = await searchBooks(q);
    if (!items.length) {
      box.innerHTML = `<p style="color:var(--text-muted);margin:0">Ничего не найдено. Заполните поля вручную.</p>`;
      return;
    }
    box.innerHTML = items.map((item, idx) => `
      <button type="button" class="lookup-item" data-idx="${idx}">
        ${item.cover
          ? `<img src="${escapeHtml(item.cover)}" alt="" loading="lazy" />`
          : `<div class="mini-cover">нет</div>`}
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.author)}${item.year ? ` · ${item.year}` : ""}${item.pages ? ` · ${item.pages} стр.` : ""}${item.publisher ? ` · ${escapeHtml(item.publisher)}` : ""}</span>
        </div>
        <span class="badge">${escapeHtml(SOURCE_LABELS[item.source] || item.source || "?")}</span>
      </button>
    `).join("");
    box._items = items;
  } catch (e) {
    box.innerHTML = `<p style="color:#f0a0a0;margin:0">${escapeHtml(e.message)}</p>`;
  }
}

function readFormBook() {
  const id = $("#field-id").value || uid();
  const existing = state.books.find((b) => b.id === id);
  const rating = Number($("#field-rating").value) || 0;
  return {
    id,
    title: $("#field-title").value.trim(),
    author: $("#field-author").value.trim(),
    genres: parseList($("#field-genres").value),
    language: $("#field-language").value.trim() || "русский",
    pages: Number($("#field-pages").value) || null,
    year: Number($("#field-year").value) || null,
    isbn: $("#field-isbn").value.trim(),
    status: $("#field-status").value,
    startedAt: $("#field-started").value,
    finishedAt: $("#field-finished").value,
    rating,
    publisher: $("#field-publisher").value.trim(),
    review: $("#field-review").value.trim(),
    notes: $("#field-notes").value.trim(),
    tags: parseList($("#field-tags").value),
    cover: $("#field-cover").value.trim(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function todayIso() {
  return new Date().toLocaleDateString("sv-SE");
}

function autofillDates() {
  const status = $("#field-status").value;
  if ((status === "finished" || status === "reread") && !$("#field-finished").value) {
    $("#field-finished").value = todayIso();
  }
  if (status === "reading" && !$("#field-started").value) {
    $("#field-started").value = todayIso();
  }
}

function saveBookFromForm(e) {
  e.preventDefault();
  autofillDates();
  const book = readFormBook();
  if (!book.title || !book.author) {
    toast("Укажите название и автора");
    return;
  }
  const idx = state.books.findIndex((b) => b.id === book.id);
  if (idx >= 0) state.books[idx] = book;
  else state.books.unshift(book);
  persist();
  $("#book-modal").close();
  renderLibrary();
  toast(idx >= 0 ? "Книга обновлена" : "Книга добавлена");
}

function deleteCurrentBook() {
  const id = $("#field-id").value;
  if (!id || !confirm("Удалить книгу безвозвратно?")) return;
  state.books = state.books.filter((b) => b.id !== id);
  persist();
  $("#book-modal").close();
  renderLibrary();
  toast("Книга удалена");
}

/* ---------- Detail ---------- */
function openDetail(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  const content = $("#detail-content");
  content.innerHTML = `
    <header class="modal-head">
      <h2>Карточка книги</h2>
      <button type="button" class="icon-btn" id="detail-close" aria-label="Закрыть">✕</button>
    </header>
    <div class="detail-layout">
      ${coverHtml(book, "detail-cover")}
      <div>
        <h2>${escapeHtml(book.title)}</h2>
        <p class="detail-author">${escapeHtml(book.author)}</p>
        <div class="detail-badges">
          <span class="badge status-${escapeHtml(book.status)}">${STATUS_LABELS[book.status]}</span>
          ${Number(book.rating) > 0 ? `<span class="badge rating">★ ${formatRating(book.rating)} / 10</span>` : ""}
          ${(book.genres || []).map((g) => `<span class="badge">${escapeHtml(g)}</span>`).join("")}
        </div>
        <dl class="detail-grid">
          <div><dt>Страницы</dt><dd>${book.pages ? Number(book.pages).toLocaleString("ru-RU") : "—"}</dd></div>
          <div><dt>Год</dt><dd>${book.year || "—"}</dd></div>
          <div><dt>Язык</dt><dd>${escapeHtml(book.language || "—")}</dd></div>
          <div><dt>Издательство</dt><dd>${escapeHtml(book.publisher || "—")}</dd></div>
          <div><dt>ISBN</dt><dd>${escapeHtml(book.isbn || "—")}</dd></div>
          <div><dt>Теги</dt><dd>${(book.tags || []).map(escapeHtml).join(", ") || "—"}</dd></div>
          <div><dt>Начал</dt><dd>${book.startedAt || "—"}</dd></div>
          <div><dt>Закончил</dt><dd>${book.finishedAt || "—"}</dd></div>
        </dl>
        ${book.review ? `<p class="detail-notes" style="margin-bottom:0.8rem"><strong>Отзыв.</strong> ${escapeHtml(book.review)}</p>` : ""}
        ${book.notes ? `<p class="detail-notes">${escapeHtml(book.notes)}</p>` : `<p style="color:var(--text-muted)">Заметок пока нет.</p>`}
        <div class="modal-foot" style="border:0;padding-top:1rem;margin-top:1rem">
          <div class="spacer"></div>
          <button type="button" class="btn ghost" id="detail-edit">Редактировать</button>
        </div>
      </div>
    </div>
  `;
  $("#detail-modal").showModal();
  bindCoverFallbacks(content);
  $("#detail-close").onclick = () => $("#detail-modal").close();
  $("#detail-edit").onclick = () => {
    $("#detail-modal").close();
    openBookModal(book);
  };
}

/* ---------- Stats / Charts ---------- */
function destroyCharts() {
  Object.values(state.charts).forEach((c) => c?.destroy?.());
  state.charts = {};
}

function chartDefaults() {
  Chart.defaults.color = "#9bb5a5";
  Chart.defaults.borderColor = "rgba(168, 212, 181, 0.12)";
  Chart.defaults.font.family = "'Figtree', sans-serif";
}

let statsInitialized = false;

function renderPeriodBooks(books, label) {
  $("#period-books-title").textContent = label ? `Книги: ${label}` : "Книги периода";
  const sorted = [...books].sort((a, b) => bookDate(b).localeCompare(bookDate(a)));
  const box = $("#period-books");
  if (!sorted.length) {
    box.innerHTML = `<p class="empty-text">За этот период книг нет.</p>`;
    return;
  }
  box.innerHTML = sorted.slice(0, 60).map((b) => `
    <button type="button" class="period-book" data-id="${b.id}">
      ${coverHtml(b, "period-cover")}
      <span class="period-book-meta">
        <span class="title">${escapeHtml(b.title)}</span>
        <span class="author">${escapeHtml(b.author)}</span>
        <span class="period-book-info">${STATUS_LABELS[b.status] || ""} · ${bookDate(b).split("-").reverse().join(".")}${Number(b.rating) > 0 ? ` · ★ ${formatRating(b.rating)}` : ""}</span>
      </span>
    </button>
  `).join("") + (sorted.length > 60 ? `<p class="empty-text">…и ещё ${sorted.length - 60}</p>` : "");
  bindCoverFallbacks(box);
}

function renderStats() {
  const yearSel = $("#stats-year");
  const monthSel = $("#stats-month");
  if (!statsInitialized) {
    statsInitialized = true;
    const thisYear = String(new Date().getFullYear());
    if (availableYears(state.books).includes(thisYear)) {
      yearSel.innerHTML = `<option value="${thisYear}">${thisYear}</option>`;
      yearSel.value = thisYear;
    }
  }
  fillPeriodSelects(yearSel, monthSel, state.books);

  const year = yearSel.value;
  const month = monthSel.value;
  const books = filterBooksByPeriod(state.books, year, month);
  const label = periodLabel(year, month);
  $("#stats-caption").textContent = label ? `Период: ${label}` : "Период: всё время";
  renderPeriodBooks(books, label);

  $("#kpi-row").innerHTML = computeKpis(books).map((k, i) => `
    <article class="kpi" style="animation-delay:${i * 50}ms">
      <p class="label">${escapeHtml(k.label)}</p>
      <p class="value">${escapeHtml(String(k.value))}</p>
    </article>
  `).join("");

  if (typeof Chart === "undefined") return;
  chartDefaults();
  destroyCharts();

  const genres = genreDistribution(books);
  state.charts.genres = new Chart($("#chart-genres"), {
    type: "doughnut",
    data: {
      labels: genres.map(([g]) => g),
      datasets: [{
        data: genres.map(([, n]) => n),
        backgroundColor: ["#5fa87a", "#3f7a58", "#a8d4b5", "#2d5a42", "#d4a84b", "#7eb892", "#1e4030", "#c5d6cb", "#8fbc9a", "#4a6b58"],
        borderWidth: 0,
      }],
    },
    options: { plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } } },
  });

  const monthly = monthlyActivity(state.books, year);
  $("#chart-monthly-title").textContent = year === "all"
    ? "Прочитано за последние 12 месяцев"
    : `Прочитано по месяцам, ${year}`;
  const isSelected = (k) => month === "all"
    || (year === "all" ? k.endsWith(`-${month}`) : k === `${year}-${month}`);
  const barColor = (alpha) => monthly.keys.map((k) => (
    isSelected(k) ? `rgba(95, 168, 122, ${alpha})` : "rgba(95, 168, 122, 0.25)"
  ));
  state.charts.monthly = new Chart($("#chart-monthly"), {
    data: {
      labels: monthly.labels,
      datasets: [
        {
          type: "bar",
          label: "Книг",
          data: monthly.books,
          backgroundColor: barColor(0.85),
          borderRadius: 8,
          yAxisID: "y",
        },
        {
          type: "line",
          label: "Страниц",
          data: monthly.pages,
          borderColor: "#d4a84b",
          backgroundColor: "#d4a84b",
          tension: 0.35,
          pointRadius: 3,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      onClick: (_, elements) => {
        const idx = elements[0]?.index;
        if (idx === undefined || !monthly.books[idx]) return;
        const [y, m] = monthly.keys[idx].split("-");
        const again = year === y && month === m;
        yearSel.value = y;
        monthSel.value = "all";
        fillPeriodSelects(yearSel, monthSel, state.books);
        monthSel.value = again ? "all" : m;
        // перерисовка удаляет график — нельзя делать это внутри его же обработчика
        setTimeout(renderStats, 0);
      },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 }, title: { display: true, text: "книги" }, grid: { color: "rgba(168,212,181,0.08)" } },
        y1: { beginAtZero: true, position: "right", title: { display: true, text: "страницы" }, grid: { display: false } },
        x: { grid: { display: false } },
      },
    },
  });

  const ratings = ratingHistogram(books);
  state.charts.ratings = new Chart($("#chart-ratings"), {
    type: "bar",
    data: {
      labels: ratings.labels,
      datasets: [{
        label: "Книг",
        data: ratings.values,
        backgroundColor: "rgba(212, 168, 75, 0.7)",
        borderRadius: 6,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } }, x: { grid: { display: false } } },
    },
  });

  const statuses = statusDistribution(books);
  state.charts.status = new Chart($("#chart-status"), {
    type: "pie",
    data: {
      labels: statuses.map((s) => s.label),
      datasets: [{
        data: statuses.map((s) => s.count),
        backgroundColor: ["#6a9fd4", "#5fa87a", "#9bb5a5", "#b894e0", "#c45c5c"],
        borderWidth: 0,
      }],
    },
    options: { plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } } },
  });

  const byYear = booksPerYear(state.books);
  state.charts.years = new Chart($("#chart-years"), {
    type: "line",
    data: {
      labels: byYear.labels.length ? byYear.labels : ["—"],
      datasets: [{
        label: "Прочитано",
        data: byYear.values.length ? byYear.values : [0],
        borderColor: "#5fa87a",
        backgroundColor: "rgba(95, 168, 122, 0.15)",
        fill: true,
        tension: 0.35,
        pointRadius: 4,
        pointBackgroundColor: "#a8d4b5",
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
    },
  });

  $("#top-authors").innerHTML = topAuthors(state.books).map(([name, count]) => `
    <li><span>${escapeHtml(name)}</span><span class="count">${count}</span></li>
  `).join("") || `<li style="color:var(--text-muted)">Пока нет данных</li>`;
}

/* ---------- Challenges ---------- */
function renderChallenges() {
  const list = $("#challenges-list");
  if (!state.challenges.length) {
    list.innerHTML = `<div class="empty-state"><p class="empty-title">Нет активных вызовов</p><p class="empty-text">Поставьте цель на год — по книгам, страницам или жанру.</p></div>`;
    return;
  }
  list.innerHTML = state.challenges.map((ch) => {
    const p = challengeProgress(ch, state.books);
    const typeLabel = {
      books: "книг",
      pages: "страниц",
      genre: `книг жанра «${ch.genre}»`,
      rating: "ср. оценка",
    }[ch.type] || "";
    return `
      <article class="challenge-card" data-id="${ch.id}">
        <header>
          <div>
            <h3>${escapeHtml(ch.title)}</h3>
            <p class="challenge-meta">${escapeHtml(ch.from)} → ${escapeHtml(ch.to)} · цель: ${p.target} ${escapeHtml(typeLabel)}</p>
          </div>
          <button type="button" class="icon-btn ch-delete" data-id="${ch.id}" title="Удалить">✕</button>
        </header>
        <div class="progress-track"><div class="progress-fill" style="width:${p.pct}%"></div></div>
        <div class="progress-label">
          <span>${typeof p.current === "number" && ch.type === "rating" ? p.current.toFixed(1) : Math.round(p.current * 10) / 10} / ${p.target}</span>
          <span>${p.done ? "Готово!" : `${p.pct}%`}</span>
        </div>
      </article>
    `;
  }).join("");
}

function openChallengeModal() {
  const y = new Date().getFullYear();
  $("#ch-title").value = `${y}: 24 книги`;
  $("#ch-type").value = "books";
  $("#ch-target").value = 24;
  $("#ch-genre").value = "";
  $("#ch-from").value = `${y}-01-01`;
  $("#ch-to").value = `${y}-12-31`;
  toggleChallengeGenre();
  $("#challenge-modal").showModal();
}

function toggleChallengeGenre() {
  const show = $("#ch-type").value === "genre";
  $("#ch-genre-wrap").classList.toggle("hidden", !show);
}

function saveChallenge(e) {
  e.preventDefault();
  const ch = {
    id: uid(),
    title: $("#ch-title").value.trim(),
    type: $("#ch-type").value,
    target: Number($("#ch-target").value),
    genre: $("#ch-genre").value.trim(),
    from: $("#ch-from").value,
    to: $("#ch-to").value,
    createdAt: new Date().toISOString(),
  };
  if (!ch.title || !ch.from || !ch.to) return;
  state.challenges.unshift(ch);
  persist();
  $("#challenge-modal").close();
  renderChallenges();
  toast("Вызов создан");
}

/* ---------- Notes feed ---------- */
function renderNotes() {
  const q = ($("#notes-search").value || "").trim().toLowerCase();
  const items = state.books
    .filter((b) => (b.notes || "").trim() || (b.review || "").trim())
    .map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      body: [b.review, b.notes].filter(Boolean).join("\n\n"),
    }))
    .filter((n) => !q || `${n.title} ${n.author} ${n.body}`.toLowerCase().includes(q));

  const feed = $("#notes-feed");
  if (!items.length) {
    feed.innerHTML = `<div class="empty-state"><p class="empty-title">Заметок нет</p><p class="empty-text">Добавляйте цитаты и мысли в карточке книги.</p></div>`;
    return;
  }
  feed.innerHTML = items.map((n) => `
    <article class="note-card" data-id="${n.id}">
      <p class="book-ref">${escapeHtml(n.title)} · ${escapeHtml(n.author)}</p>
      <p class="body">${escapeHtml(n.body)}</p>
    </article>
  `).join("");
}

/* ---------- Import / Export ---------- */
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function doExport() {
  const data = exportData(state.books, state.challenges, state.settings);
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    `polka-backup-${new Date().toISOString().slice(0, 10)}.json`,
  );
  toast("Экспорт JSON сохранён");
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function doExportCsv() {
  const headers = [
    "title", "author", "genres", "pages", "year", "status", "rating",
    "language", "isbn", "publisher", "startedAt", "finishedAt", "tags", "review", "notes", "cover",
  ];
  const rows = state.books.map((b) => headers.map((h) => {
    const val = Array.isArray(b[h]) ? b[h].join("; ") : b[h];
    return csvEscape(val);
  }).join(","));
  const csv = "\uFEFF" + [headers.join(","), ...rows].join("\n");
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `polka-books-${new Date().toISOString().slice(0, 10)}.csv`);
  toast("CSV для Numbers / Excel готов");
}

async function importFromUrlParam() {
  const params = new URLSearchParams(location.search);
  const path = params.get("import");
  if (!path) return;
  history.replaceState(null, "", location.pathname);
  if (/^[a-z]+:|^\/\//i.test(path)) return;
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Файл не найден (${res.status})`);
    applyImport(await res.json());
  } catch (e) {
    toast(e.message || "Ошибка импорта");
  }
}

function doImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyImport(JSON.parse(reader.result));
    } catch (e) {
      toast(e.message || "Ошибка импорта");
    }
  };
  reader.readAsText(file);
}

function applyImport(parsed) {
  const data = importData(parsed);
  if (data.mode === "merge") {
    if (!confirm(`Добавить ${data.books.length} книг на полку? Повторов не будет, уже добавленные книги обновятся.`)) return;
    const result = mergeBooks(state.books, data.books);
    state.books = result.books;
    state.settings = { ...state.settings, demoLoaded: true };
    persist();
    renderLibrary();
    toast(`Добавлено ${result.added}, обновлено ${result.updated}`);
    return;
  }
  if (!confirm(`Импортировать ${data.books.length} книг? Текущие данные будут заменены.`)) return;
  state.books = data.books;
  state.challenges = data.challenges;
  state.settings = { ...state.settings, ...data.settings, demoLoaded: true };
  persist({ force: true });
  renderLibrary();
  toast("Импорт завершён");
}

/* ---------- Events ---------- */
function bindEvents() {
  $$(".nav-btn").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.view)));

  $("#btn-add").addEventListener("click", () => openBookModal());
  $("#btn-add-empty").addEventListener("click", () => openBookModal());
  $("#modal-close").addEventListener("click", () => $("#book-modal").close());
  $("#btn-cancel").addEventListener("click", () => $("#book-modal").close());
  $("#btn-delete").addEventListener("click", deleteCurrentBook);
  $("#book-form").addEventListener("submit", saveBookFromForm);
  $("#field-rating").addEventListener("input", updateRatingOutput);
  $("#field-status").addEventListener("change", autofillDates);
  $("#period-reset").addEventListener("click", resetPeriod);
  $("#field-cover").addEventListener("input", updateCoverPreview);
  $("#btn-lookup").addEventListener("click", runLookup);
  $("#lookup-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runLookup();
    }
  });
  $("#lookup-results").addEventListener("click", (e) => {
    const item = e.target.closest(".lookup-item");
    if (!item) return;
    const data = $("#lookup-results")._items?.[Number(item.dataset.idx)];
    if (data) fillFromLookup(data);
  });

  $("#library-grid").addEventListener("click", (e) => {
    const card = e.target.closest(".book-card");
    if (card) openDetail(card.dataset.id);
  });

  ["library-search", "filter-status", "filter-genre", "filter-year", "filter-month", "sort-by"].forEach((id) => {
    $(`#${id}`).addEventListener("input", renderLibrary);
    $(`#${id}`).addEventListener("change", renderLibrary);
  });

  $$(".view-toggle .icon-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.layout = btn.dataset.layout;
      state.settings.layout = state.layout;
      persist();
      renderLibrary();
    });
  });

  $("#stats-year").addEventListener("change", renderStats);
  $("#stats-month").addEventListener("change", renderStats);
  $("#period-books").addEventListener("click", (e) => {
    const item = e.target.closest(".period-book");
    if (item) openDetail(item.dataset.id);
  });

  $("#btn-add-challenge").addEventListener("click", openChallengeModal);
  $("#challenge-close").addEventListener("click", () => $("#challenge-modal").close());
  $("#ch-cancel").addEventListener("click", () => $("#challenge-modal").close());
  $("#ch-type").addEventListener("change", toggleChallengeGenre);
  $("#challenge-form").addEventListener("submit", saveChallenge);
  $("#challenges-list").addEventListener("click", (e) => {
    const del = e.target.closest(".ch-delete");
    if (!del) return;
    state.challenges = state.challenges.filter((c) => c.id !== del.dataset.id);
    persist();
    renderChallenges();
    toast("Вызов удалён");
  });

  $("#notes-search").addEventListener("input", renderNotes);
  $("#notes-feed").addEventListener("click", (e) => {
    const card = e.target.closest(".note-card");
    if (card) openDetail(card.dataset.id);
  });

  $("#btn-export").addEventListener("click", doExport);
  $("#btn-export-csv").addEventListener("click", doExportCsv);
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) doImport(file);
    e.target.value = "";
  });
}

async function fillPublisherList() {
  const list = $("#publisher-list");
  if (!list) return;
  const pubs = await loadPublishers();
  if (!pubs.length) return;
  list.innerHTML = pubs.map((p) => `<option value="${escapeHtml(p)}"></option>`).join("");
}

/* ---------- Sync ---------- */
function renderSyncModal() {
  const on = Boolean(syncCfg);
  $("#sync-off").classList.toggle("hidden", on);
  $("#sync-on").classList.toggle("hidden", !on);
  $("#sync-connect").classList.toggle("hidden", on);
  $("#sync-now").classList.toggle("hidden", !on);
  $("#sync-disconnect").classList.toggle("hidden", !on);
  $("#sync-repo").textContent = DEFAULT_REPO;
  $("#sync-state").textContent = on
    ? ($("#btn-sync").title || "Синхронизация включена")
    : "Синхронизация выключена: полка хранится только в этом браузере.";
  if (on) renderSyncQr(syncLinkFor(syncCfg));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function renderSyncQr(link) {
  const box = $("#sync-qr");
  box.innerHTML = "";
  try {
    if (!window.qrcode) await loadScript("https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js");
    const qr = window.qrcode(0, "M");
    qr.addData(link);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
  } catch {
    box.textContent = "QR-код не загрузился — используйте кнопку «Скопировать ссылку».";
  }
}

function openSyncModal() {
  renderSyncModal();
  $("#sync-modal").showModal();
}

async function connectSync(token) {
  const cfg = { token: token.trim(), repo: DEFAULT_REPO };
  if (!cfg.token) {
    toast("Вставьте ключ доступа");
    return false;
  }
  try {
    await checkSyncAccess(cfg);
    const remote = await fetchSyncLibrary(cfg);
    syncCfg = cfg;
    saveSync(cfg);
    remoteKind = "github";
    const localReal = state.books.length && !onlyDemo(state.books);
    if (remote?.books?.length && localReal) {
      const takeRemote = confirm(
        `В GitHub уже есть полка: ${remote.books.length} книг.\n`
        + `В этом браузере: ${state.books.length} книг.\n\n`
        + "ОК — открыть полку из GitHub.\n"
        + "Отмена — сохранить в GitHub полку из этого браузера.",
      );
      if (takeRemote) {
        adoptLibrary(remote);
        saveSyncBase(remote.savedAt);
      } else {
        persist({ force: true });
      }
    } else if (remote?.books?.length) {
      adoptLibrary(remote);
      saveSyncBase(remote.savedAt);
    } else {
      persist({ force: true });
    }
    renderLibrary();
    setSyncStatus("ok", `Синхронизировано: ${state.books.length} книг`);
    toast("Синхронизация включена");
    return true;
  } catch (e) {
    toast(`Не получилось подключить: ${e.message}`);
    return false;
  }
}

function disconnectSync() {
  if (!confirm("Отключить синхронизацию на этом устройстве? Книги останутся в браузере и в GitHub.")) return;
  syncCfg = null;
  saveSync(null);
  saveSyncBase("");
  history.replaceState(null, "", location.pathname + location.search);
  remoteKind = serverAvailable ? "server" : null;
  setSyncStatus("off", "Синхронизация выключена");
  renderSyncModal();
}

function bindSyncEvents() {
  $("#btn-sync").addEventListener("click", openSyncModal);
  $("#sync-close").addEventListener("click", () => $("#sync-modal").close());
  $("#sync-connect").addEventListener("click", async () => {
    if (await connectSync($("#sync-token").value)) {
      $("#sync-token").value = "";
      renderSyncModal();
    }
  });
  $("#sync-now").addEventListener("click", async () => {
    await refreshFromServer();
    renderSyncModal();
    toast($("#btn-sync").title);
  });
  $("#sync-disconnect").addEventListener("click", disconnectSync);
  $("#sync-copy").addEventListener("click", async () => {
    const link = syncLinkFor(syncCfg);
    try {
      await navigator.clipboard.writeText(link);
      toast("Ссылка скопирована — откройте её на телефоне");
    } catch {
      prompt("Скопируйте ссылку и откройте на телефоне:", link);
    }
  });
}

async function boot() {
  const hashToken = takeTokenFromHash();
  const newToken = hashToken && hashToken !== syncCfg?.token;
  if (newToken) {
    syncCfg = { token: hashToken, repo: DEFAULT_REPO };
    saveSync(syncCfg);
    saveSyncBase("");
  }
  await initData();
  bindEvents();
  bindSyncEvents();
  if (serverAvailable) $("#btn-sync").classList.add("hidden");
  else $("#btn-download-mac")?.classList.add("hidden");
  if (!syncCfg) setSyncStatus("off", "Синхронизация выключена");
  if (newToken && remoteKind === "github") toast(`Синхронизация включена: ${state.books.length} книг`);
  renderLibrary();
  maybeShowPhoneHint();
  fillPublisherList();
  importFromUrlParam();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshFromServer();
  });
}

function maybeShowPhoneHint() {
  const host = location.hostname;
  const banner = $("#phone-banner");
  const hint = $("#phone-hint-url");
  if (!banner) return;
  const isLocalLoopback = host === "127.0.0.1" || host === "localhost";
  const isPhone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || (window.matchMedia && window.matchMedia("(max-width: 900px)").matches);
  if (isLocalLoopback && isPhone) {
    banner.classList.remove("hidden");
    if (hint) hint.textContent = "запустите ./start.sh на Mac и откройте показанный там IP";
  } else if (!isLocalLoopback && location.port) {
    // Уже открыто по LAN IP — подсказка не нужна, но покажем текущий URL для «На экран Домой»
    banner.classList.add("hidden");
  }
}

boot();
