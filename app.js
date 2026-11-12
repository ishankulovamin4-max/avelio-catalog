import {
  createCatalog,
  buildSearchIndex,
  search,
  parseRoute,
  formatRoute,
  routeFromStartParam,
  botStartLink,
  thumbUrl,
  photoUrl,
  pageSlice,
  plural,
  CART_LIMIT,
  CART_STORAGE_KEY,
  emptyCart,
  normalizeCart,
  cartHas,
  cartAdd,
  cartRemove,
  cartPending,
  cartMarkSent,
  cartResetSent,
  serializeCart,
  parseCart,
  cartBotLink,
} from "./logic.mjs?v=e7c2a396";

const BG = "#101112";
const PAGE_SIZE = 24;
const THUMB_CONCURRENCY = 8;
const HOME = { view: "home" };
const CART = { view: "cart" };

const app = document.querySelector("#app");
const main = document.querySelector("#main");
const dialog = document.querySelector("#item-dialog");
const searchForm = document.querySelector("#search-form");
const searchInput = document.querySelector("#search");
const clearSearch = document.querySelector("#search-clear");
const backButton = document.querySelector("#back");
const announcement = document.querySelector("#announcement");
const cartFooter = document.querySelector("#cart-footer");

const webApp = window.Telegram?.WebApp;
const telegram = webApp && typeof webApp.initData === "string"
  && webApp.initData.trim() !== "" ? webApp : null;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const snapshots = new Map();
const thumbnails = new Set();

let serial = 0;
let catalog = null;
let searchIndex = null;
let loading = false;
let base = null;
let searchTimer = 0;
let composing = false;
let layerCleanup = null;
let layerCartSync = null;
let layerCode = null;
let returnFocus = null;
let coveredScroll = 0;
let thumbnailFrame = 0;

let cart = readLocalCart();
let cartChangedByUser = false;
const cloudStorage = getCloudStorage();
const cloudUnsyncedAtStart = readCloudUnsynced();
let cloudWriting = false;
let cloudQueued = null;
let cloudVersion = 0;
let cloudRetryTimer = 0;
let cloudCartPending = Boolean(cloudStorage);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className = "button") {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}

function routeLink(text, route, className = "") {
  const node = element("a", className, text);
  const hash = formatRoute(route);
  node.href = hash;
  node.dataset.route = hash;
  return node;
}

function botLink(kind, code, className = "button") {
  const text = kind === "price" ? "Узнать цену" : "Подобрать мебель";
  const url = botStartLink(kind, code);

  if (!url) {
    const unavailable = button(text, className);
    unavailable.disabled = true;
    return unavailable;
  }

  const node = element("a", className, text);
  node.href = url;
  node.dataset.bot = "true";
  return node;
}

// С Bot API 7.0 openTelegramLink мини-приложение не закрывает: на iPhone чат
// с ботом остаётся под каталогом, и человек жмёт «Узнать цену» снова и снова.
// Поэтому после перехода закрываем каталог сами, а повторные нажатия глушим.
const BOT_CLOSE_DELAY_MS = 400;
const BOT_GUARD_MS = 4000;
let botOpeningUntil = 0;

function botOpening() {
  return Date.now() < botOpeningUntil;
}

function telegramClient() {
  if (telegram) return telegram;
  // Внутри Telegram без initData (редкий запуск) переход всё равно через клиент.
  const platform = webApp?.platform;
  return platform && platform !== "unknown"
    && typeof webApp.openTelegramLink === "function" ? webApp : null;
}

function markBotOpening(trigger) {
  if (!trigger?.isConnected) return;

  const label = trigger.textContent;
  trigger.textContent = "Открываем чат…";
  trigger.classList.add("is-opening");
  trigger.setAttribute("aria-disabled", "true");
  if (trigger instanceof HTMLButtonElement) trigger.disabled = true;

  window.setTimeout(() => {
    if (!trigger.isConnected) return;
    trigger.textContent = label;
    trigger.classList.remove("is-opening");
    trigger.removeAttribute("aria-disabled");
    if (trigger instanceof HTMLButtonElement) trigger.disabled = false;
  }, BOT_GUARD_MS);
}

function openBotUrl(url, trigger) {
  if (botOpening()) return false;
  botOpeningUntil = Date.now() + BOT_GUARD_MS;
  markBotOpening(trigger);
  announce("Открываем чат с ботом");

  const client = telegramClient();
  if (client) {
    try {
      client.openTelegramLink(url);
      try {
        client.HapticFeedback?.impactOccurred("medium");
      } catch {
        // Тактильный отклик необязателен.
      }
      window.setTimeout(() => {
        try {
          client.close();
        } catch {
          // Старый клиент закрывает мини-приложение сам при переходе.
        }
      }, BOT_CLOSE_DELAY_MS);
      return true;
    } catch {
      // Если клиент не поддерживает переход, используем обычную ссылку.
    }
  }
  window.location.assign(url);
  return true;
}

function countText(count) {
  return `${count} ${plural(count, "вещь", "вещи", "вещей")}`;
}

function announce(text) {
  announcement.textContent = text;
}

function telegramCall(name, ...args) {
  if (typeof telegram?.[name] !== "function") return;
  try {
    telegram[name](...args);
  } catch {
    // Необязательная возможность старого клиента не блокирует каталог.
  }
}

function syncTelegramBack() {
  if (!telegram?.BackButton) return;
  try {
    if (activeRoute.view === "home") {
      telegram.BackButton.hide();
    } else {
      telegram.BackButton.show();
    }
  } catch {
    // Ошибка API не блокирует остальные переходы.
  }
}

function readLocalCart() {
  try {
    return parseCart(window.localStorage.getItem(CART_STORAGE_KEY));
  } catch {
    return emptyCart();
  }
}

function readCloudUnsynced() {
  try {
    return window.localStorage.getItem(`${CART_STORAGE_KEY}_unsynced`) === "1";
  } catch {
    return false;
  }
}

function getCloudStorage() {
  try {
    if (
      telegram
      && typeof telegram.isVersionAtLeast === "function"
      && telegram.isVersionAtLeast("6.9")
      && typeof telegram.CloudStorage?.getItem === "function"
      && typeof telegram.CloudStorage?.setItem === "function"
    ) {
      return telegram.CloudStorage;
    }
  } catch {
    // CloudStorage необязателен.
  }
  return null;
}

function writeLocalCart(text) {
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, text);
  } catch {
    // В приватном режиме корзина остаётся в памяти сеанса.
  }
}

function flushCloudWrite() {
  if (
    !cloudStorage
    || cloudWriting
    || cloudRetryTimer
    || cloudQueued === null
    || cloudQueued.attempts >= 4
  ) return;

  const write = cloudQueued;
  cloudQueued = null;
  cloudWriting = true;
  write.attempts += 1;
  let finished = false;

  const finish = (err, ok) => {
    if (finished) return;
    finished = true;
    clearTimeout(writeTimeout);
    cloudWriting = false;

    if (write.version === cloudVersion && cloudQueued === null) {
      if (!err && ok !== false) {
        try {
          window.localStorage.removeItem(`${CART_STORAGE_KEY}_unsynced`);
        } catch {
          // Неснятая метка сохраняет приоритет локальной корзины.
        }
      } else {
        // Не теряем последнюю версию даже после исчерпания повторов.
        cloudQueued = write;
        const delay = [2000, 5000, 15000][write.attempts - 1];
        if (delay !== undefined) {
          cloudRetryTimer = window.setTimeout(() => {
            cloudRetryTimer = 0;
            flushCloudWrite();
          }, delay);
        }
      }
    }

    flushCloudWrite();
  };

  // Telegram может не вызвать ответ: без этого запись навсегда заняла бы очередь.
  const writeTimeout = window.setTimeout(() => finish(true, false), 10000);

  try {
    cloudStorage.setItem(CART_STORAGE_KEY, write.text, finish);
  } catch {
    finish(true, false);
  }
}

function persistCart() {
  const text = serializeCart(cart);

  if (cloudStorage) {
    try {
      window.localStorage.setItem(`${CART_STORAGE_KEY}_unsynced`, "1");
    } catch {
      // В приватном режиме метка может быть недоступна.
    }
  }
  writeLocalCart(text);

  if (cloudStorage) {
    // Последовательные записи не дают старому ответу затереть новое состояние.
    // Пока идёт запись, сохраняем только самую свежую следующую версию.
    clearTimeout(cloudRetryTimer);
    cloudRetryTimer = 0;
    cloudQueued = { text, version: ++cloudVersion, attempts: 0 };
    flushCloudWrite();
  }
}

function pruneCart(state) {
  let result = normalizeCart(state);
  if (!catalog) return result;

  for (const code of result.items) {
    if (!catalog.itemByCode(code)) result = cartRemove(result, code);
  }
  return result;
}

function cartCodes() {
  return catalog
    ? cart.items.filter((code) => catalog.itemByCode(code))
    : [];
}

function syncCartLinks() {
  const count = cartCodes().length;
  for (const link of document.querySelectorAll("[data-cart-link]")) {
    link.textContent = count ? `Корзина · ${count}` : "Корзина";
    link.setAttribute(
      "aria-label",
      count ? `Корзина, ${countText(count)}` : "Корзина",
    );

    if (activeRoute.view === "cart") {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

function cartEntry() {
  const link = routeLink("Корзина", CART, "cart-link");
  link.dataset.cartLink = "true";
  return link;
}

function refreshCartUI() {
  syncCartLinks();
  layerCartSync?.();

  if (catalog && base?.route.view === "cart") {
    const scroll = dialog.open ? coveredScroll : app.scrollTop;
    main.replaceChildren();
    renderCart();
    app.scrollTop = scroll;
    if (dialog.open) coveredScroll = app.scrollTop;
    scheduleThumbnails();
  }
}

function changeCart(next, { user = true } = {}) {
  const normalized = pruneCart(next);
  const changed = serializeCart(normalized) !== serializeCart(cart);

  if (user && changed) cartChangedByUser = true;
  cart = normalized;
  persistCart();
  refreshCartUI();
}

function restoreCloudCart() {
  if (!cloudStorage) return;

  if (cloudUnsyncedAtStart) {
    // Неподтверждённая локальная версия верна, даже если корзина пуста.
    cloudCartPending = false;
    persistCart();
    refreshCartUI();
    return;
  }

  let settled = false;
  const loadingTimer = window.setTimeout(() => {
    cloudCartPending = false;
    refreshCartUI();
  }, 4000);

  const finish = (err, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(loadingTimer);
    cloudCartPending = false;

    const remote = err ? emptyCart() : pruneCart(parseCart(value));

    if (cartChangedByUser) {
      // Ответ облака не возвращает удалённые вещи и сброшенные отметки.
      persistCart();
      refreshCartUI();
    } else if (remote.items.length > 0) {
      changeCart(remote, { user: false });
    } else {
      // Пустое или недоступное облако не очищает локальную корзину.
      // При ошибке чтения облако не перезаписываем: там может быть более новая корзина.
      if (!err && cart.items.length > 0) persistCart();
      refreshCartUI();
    }
  };

  try {
    cloudStorage.getItem(CART_STORAGE_KEY, finish);
  } catch {
    finish(true, "");
  }
}

function newState(depth, background = null) {
  return {
    avelio: session,
    key: ++serial,
    depth,
    background,
  };
}

function isOurState(state) {
  return state?.avelio === session
    && Number.isSafeInteger(state.key)
    && Number.isSafeInteger(state.depth)
    && state.depth >= 0;
}

const startRoute = telegram
  ? routeFromStartParam(telegram.initDataUnsafe?.start_param)
  : null;

let activeRoute = startRoute ?? parseRoute(location.hash);
let activeState = newState(0);
let handledLocation = "";

history.scrollRestoration = "manual";
history.replaceState(activeState, "", formatRoute(activeRoute));

function rememberBase() {
  if (!base) return;
  base.scroll = dialog.open ? coveredScroll : app.scrollTop;
  snapshots.set(base.key, {
    hash: base.hash,
    scroll: base.scroll,
    pages: base.pages,
  });
}

function disconnectFeed() {
  base?.observer?.disconnect();
  if (base) base.observer = null;
}

function currentBackground() {
  if (!base) return null;
  return { key: base.key, route: base.route };
}

function navigate(route, { replace = false } = {}) {
  clearTimeout(searchTimer);
  const hash = formatRoute(route);
  if (hash === formatRoute(activeRoute)) return;

  rememberBase();
  const nextRoute = parseRoute(hash);
  const background = nextRoute.view === "item" ? currentBackground() : null;

  const nextState = replace
    ? { ...activeState, background }
    : newState(activeState.depth + 1, background);

  history[replace ? "replaceState" : "pushState"](nextState, "", hash);
  activeState = nextState;
  activeRoute = nextRoute;
  handledLocation = `${nextState.key}:${location.hash}`;
  renderCurrent();
}

function goBack() {
  clearTimeout(searchTimer);
  if (activeState.depth > 0) {
    history.back();
  } else {
    navigate(HOME, { replace: true });
  }
}

function onHistoryChange() {
  let nextState = history.state;

  if (!isOurState(nextState)) {
    // Стороннее изменение hash не считается доказанной историей приложения.
    nextState = newState(0);
    history.replaceState(nextState, "", location.href);
  }

  const marker = `${nextState.key}:${location.hash}`;
  if (marker === handledLocation) return;

  clearTimeout(searchTimer);
  rememberBase();
  activeState = nextState;
  activeRoute = parseRoute(location.hash);
  handledLocation = marker;
  renderCurrent();
}

function syncChrome() {
  backButton.hidden = activeRoute.view === "home" || Boolean(telegram?.BackButton);

  const visibleRoute = activeRoute.view === "item" ? base?.route : activeRoute;
  const query = visibleRoute?.view === "search" ? visibleRoute.q : "";

  if (searchInput.value !== query) searchInput.value = query;
  clearSearch.hidden = searchInput.value.length === 0;
  cartFooter.hidden = activeRoute.view !== "cart" || cartCodes().length === 0;
  syncCartLinks();
  syncTelegramBack();
}

function fallback(code) {
  const node = element("div", "image-fallback");
  node.append(
    element("span", "", "Фото недоступно"),
    element("small", "", code),
  );
  return node;
}

function scheduleThumbnails() {
  if (thumbnailFrame) return;
  thumbnailFrame = requestAnimationFrame(pumpThumbnails);
}

function cancelThumbnail(record) {
  const image = record.image;
  record.image = null;
  record.status = "idle";

  if (image) {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    image.remove();
  }
}

function startThumbnail(record, visible) {
  // Новая попытка получает новый img: запоздавшие события отменённой
  // загрузки не могут завершить или испортить следующую попытку.
  const image = element("img");
  image.alt = "";
  image.width = record.width;
  image.height = record.height;
  image.decoding = "async";
  image.setAttribute("fetchpriority", visible ? "high" : "low");

  record.image = image;
  record.status = "loading";
  record.node.append(image);

  const finish = (ok) => {
    if (record.image !== image || record.status !== "loading") return;
    image.onload = null;
    image.onerror = null;
    record.status = ok ? "loaded" : "failed";
    thumbnails.delete(record);

    if (ok) {
      record.node.classList.add("is-loaded");
    } else {
      image.removeAttribute("src");
      image.remove();
      record.node.append(fallback(record.code));
    }
    scheduleThumbnails();
  };

  image.onload = () => finish(true);
  image.onerror = () => finish(false);
  image.src = record.url;
}

function pumpThumbnails() {
  thumbnailFrame = 0;

  const viewport = app.getBoundingClientRect();
  const header = app.querySelector(".header").getBoundingClientRect();
  const top = Math.max(viewport.top, header.bottom);
  const bottom = viewport.bottom;
  const height = Math.max(1, bottom - top);
  const candidates = [];
  const running = [];

  for (const record of thumbnails) {
    if (!record.node.isConnected) {
      cancelThumbnail(record);
      thumbnails.delete(record);
      continue;
    }

    if (dialog.open) {
      if (record.status === "loading") cancelThumbnail(record);
      continue;
    }

    const rect = record.node.getBoundingClientRect();
    const distance = Math.max(top - rect.bottom, rect.top - bottom, 0);
    const visible = rect.bottom > top && rect.top < bottom;
    const position = Math.abs((rect.top + rect.bottom - top - bottom) / 2);

    record.distance = distance;
    record.visible = visible;
    record.position = position;

    if (record.status === "loading" && distance > height * 2) {
      cancelThumbnail(record);
    }

    if (record.status === "loading") {
      running.push(record);
    } else if (distance <= height) {
      candidates.push(record);
    }
  }

  if (dialog.open) return;

  candidates.sort((a, b) => (
    Number(b.visible) - Number(a.visible)
    || a.distance - b.distance
    || a.position - b.position
  ));

  // Видимые ячейки не ждут занятых предзагрузкой восьми мест.
  // Сначала освобождаем места за счёт самых далёких невидимых запросов.
  const visibleWaiting = candidates.filter((record) => record.visible).length;
  let needed = Math.max(0, visibleWaiting - (THUMB_CONCURRENCY - running.length));
  const preemptible = running
    .filter((record) => !record.visible)
    .sort((a, b) => b.distance - a.distance || b.position - a.position);

  for (const record of preemptible) {
    if (needed <= 0) break;
    cancelThumbnail(record);
    running.splice(running.indexOf(record), 1);
    needed -= 1;
  }

  let slots = THUMB_CONCURRENCY - running.length;
  for (const record of candidates) {
    if (slots <= 0) break;
    startThumbnail(record, record.visible);
    slots -= 1;
  }
}

function thumbnail(code, item) {
  const frame = element("div", "thumb");

  const url = thumbUrl(code, item);
  if (!url) {
    frame.append(fallback(code));
    return frame;
  }

  thumbnails.add({
    node: frame,
    code,
    url,
    width: 600,
    height: 450,
    image: null,
    status: "idle",
  });
  scheduleThumbnails();
  return frame;
}

function heading(title, subtitle, className = "") {
  const node = element("div", `page-heading ${className}`.trim());
  node.append(element("h1", "", title));
  if (subtitle) node.append(element("p", "", subtitle));
  return node;
}

function statePanel(title, copy, action, titleTag = "h1") {
  const panel = element("section", "state-panel");
  panel.append(element(titleTag, "", title));
  if (copy) panel.append(element("p", "muted", copy));
  if (action) panel.append(action);
  return panel;
}

function renderHome(route) {
  const selectedRoom = route.view === "room"
    ? catalog.rooms.find((room) => room.id === route.room)
    : null;

  const rooms = element("nav", "rooms");
  rooms.setAttribute("aria-label", "Комнаты");

  const all = routeLink("Все", HOME, "room-link");
  if (!selectedRoom) all.setAttribute("aria-current", "page");
  rooms.append(all);

  for (const room of catalog.rooms) {
    const link = routeLink(room.name, { view: "room", room: room.id }, "room-link");
    if (selectedRoom?.id === room.id) link.setAttribute("aria-current", "page");
    rooms.append(link);
  }

  main.append(
    rooms,
    heading(
      "Мебель для вашего дома",
      "Премиальная мебель высокого качества с фабрик Китая.",
      "home-heading",
    ),
  );

  const sections = catalog.roomSections(selectedRoom?.id);
  const list = element("div", "section-list");

  for (const section of sections) {
    const link = routeLink(
      undefined,
      { view: "section", section: section.id },
      "section-card",
    );
    const firstCode = section.items[0];

    if (firstCode) {
      link.append(thumbnail(firstCode, catalog.itemByCode(firstCode)));
    } else {
      const empty = element("div", "thumb");
      empty.append(element("div", "image-fallback", "Раздел пока пуст"));
      link.append(empty);
    }

    const caption = element("div", "section-caption");
    caption.append(
      element("h2", "", section.name),
      element("p", "", countText(section.items.length)),
    );
    link.append(caption);
    list.append(link);
  }

  main.append(list);

  if (sections.length === 0) {
    main.append(element("p", "muted", "В этой комнате пока нет разделов."));
  }

  main.append(botLink("pick", undefined, "button home-cta"));
}

function productCard(code) {
  const item = catalog.itemByCode(code);
  const li = element("li");
  const link = routeLink(undefined, { view: "item", code }, "product-card");

  link.append(
    thumbnail(code, item),
    element("h2", "", item.n),
    element("p", "product-code", code),
  );
  li.append(link);
  return li;
}

function appendBatch(record) {
  const codes = pageSlice(record.codes, record.pages, PAGE_SIZE);
  const fragment = document.createDocumentFragment();

  for (const code of codes) fragment.append(productCard(code));

  record.grid.append(fragment);
  if (codes.length > 0) record.pages += 1;
  record.more.hidden = record.pages * PAGE_SIZE >= record.codes.length;
  scheduleThumbnails();
}

function loadNextBatch(record) {
  if (base !== record || dialog.open || record.more.hidden) return;

  record.observer?.unobserve(record.more);
  appendBatch(record);

  // Повторное наблюдение также заполняет высокий экран без ручной прокрутки.
  requestAnimationFrame(() => {
    if (base !== record || activeRoute.view === "item" || dialog.open) return;
    if (!record.more.hidden) record.observer?.observe(record.more);
  });
}

function connectFeed() {
  const record = base;
  if (!record?.more || record.more.hidden || dialog.open) return;
  if (record.observer || !("IntersectionObserver" in window)) return;

  record.observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadNextBatch(record);
  }, {
    root: app,
    rootMargin: "0px 0px 600px 0px",
    threshold: 0,
  });

  record.observer.observe(record.more);
}

function renderFeed(record, title, codes, savedPages) {
  main.append(heading(title, countText(codes.length)));
  announce(countText(codes.length));

  if (codes.length === 0) {
    const isSearch = record.route.view === "search";
    main.append(statePanel(
      isSearch ? "Ничего не нашли" : "В этом разделе пока нет вещей",
      isSearch ? "Попробуйте другое название или доверьте подбор нам." : null,
      botLink("pick"),
      "h2",
    ));
    return;
  }

  record.codes = codes;
  record.grid = element("ul", "product-grid");
  record.more = button("Показать ещё", "button more-button");
  record.more.addEventListener("click", () => loadNextBatch(record));

  main.append(record.grid, record.more);

  const pages = Math.max(1, savedPages || 1);
  for (let page = 0; page < pages && !record.more.hidden; page += 1) {
    appendBatch(record);
  }
}

function renderCart() {
  const codes = cartCodes();
  const sent = new Set(cart.sent);
  cartFooter.replaceChildren();
  cartFooter.hidden = activeRoute.view !== "cart" || codes.length === 0;

  main.append(heading("Корзина", codes.length ? countText(codes.length) : null));

  if (codes.length === 0 && cart.items.length === 0 && cloudCartPending) {
    const placeholders = element("ul", "cart-list cart-skeleton");
    placeholders.setAttribute("aria-label", "Загрузка корзины");
    placeholders.setAttribute("aria-busy", "true");

    for (let index = 0; index < 3; index += 1) {
      const row = element("li", "cart-row");
      row.setAttribute("aria-hidden", "true");
      const info = element("div", "cart-info");
      info.append(
        element("div", "cart-skeleton-line"),
        element("div", "cart-skeleton-line"),
      );
      row.append(element("div", "thumb"), info);
      placeholders.append(row);
    }

    main.append(placeholders);
    return;
  }

  if (codes.length === 0) {
    main.append(statePanel(
      "Пока здесь пусто",
      "Сохраните вещи, которые вам понравились.",
      routeLink("Смотреть каталог", HOME, "button"),
      "h2",
    ));
    return;
  }

  const list = element("ul", "cart-list");
  const fragment = document.createDocumentFragment();

  for (const code of codes) {
    const item = catalog.itemByCode(code);
    const row = element("li", "cart-row");
    const preview = routeLink(undefined, { view: "item", code }, "cart-preview");
    preview.setAttribute("aria-label", item.n);
    preview.append(thumbnail(code, item));

    const info = element("div", "cart-info");
    const title = element("h2");
    title.append(routeLink(item.n, { view: "item", code }));
    info.append(title, element("p", "product-code", code));

    if (sent.has(code)) {
      info.append(element("p", "cart-sent", "Цена запрошена"));
    }

    const remove = button("Убрать", "text-button");
    remove.setAttribute("aria-label", `Убрать из корзины: ${item.n}, ${code}`);
    remove.addEventListener("click", () => {
      changeCart(cartRemove(cart, code));
      announce("Вещь убрана из корзины");
    });
    info.append(remove);
    row.append(preview, info);
    fragment.append(row);
  }

  list.append(fragment);
  main.append(list);

  const pending = cartPending(cart).filter((code) => catalog.itemByCode(code));

  if (pending.length > 0) {
    const label = cart.sent.length === 0
      ? "Узнать цену"
      : `Узнать цену на остальные (${pending.length})`;
    const request = button(label, "button button-primary");
    request.disabled = cartBotLink(pending) === null;
    request.addEventListener("click", () => {
      if (botOpening()) return;
      const currentPending = cartPending(cart)
        .filter((code) => catalog.itemByCode(code));
      const link = cartBotLink(currentPending);
      if (!link) return;

      // Сначала сохраняем пометку «запрошено»: следом каталог закроется.
      changeCart(cartMarkSent(cart, link.taken));
      openBotUrl(link.url);
    });
    cartFooter.append(request);
  } else {
    const status = element("p", "cart-complete", "Цена запрошена по всем вещам");
    const again = button("Запросить ещё раз");
    again.addEventListener("click", () => {
      // Второй тап по кнопке цены попадает сюда, пока открывается чат.
      if (botOpening()) return;
      changeCart(cartResetSent(cart));
      announce("Можно запросить цену ещё раз");
    });
    cartFooter.append(status, again);
  }
}

function ensureBase(route, key) {
  const hash = formatRoute(route);
  if (base?.key === key && base.hash === hash) return;

  disconnectFeed();
  main.replaceChildren();
  main.classList.toggle("cart-screen", route.view === "cart");
  cartFooter.replaceChildren();
  cartFooter.hidden = true;

  const saved = snapshots.get(key);
  const snapshot = saved?.hash === hash ? saved : null;

  const record = {
    key,
    route,
    hash,
    scroll: snapshot?.scroll ?? 0,
    pages: 0,
    observer: null,
    more: null,
  };
  base = record;

  if (route.view === "home" || route.view === "room") {
    renderHome(route);
  } else if (route.view === "section") {
    const section = catalog.sectionById(route.section);
    if (section) {
      renderFeed(
        record,
        section.name,
        catalog.itemsOfSection(section.id),
        snapshot?.pages,
      );
    } else {
      main.append(statePanel(
        "Раздел не найден",
        "Вы можете выбрать другой раздел в каталоге.",
        routeLink("На главную", HOME, "button"),
      ));
    }
  } else if (route.view === "search") {
    if (route.q.trim() === "") {
      main.append(statePanel(
        "Что вы ищете?",
        "Укажите название, код вещи или размер.",
        botLink("pick"),
      ));
      announce("Что вы ищете?");
    } else {
      renderFeed(record, "Результаты поиска", search(searchIndex, route.q), snapshot?.pages);
    }
  } else if (route.view === "cart") {
    renderCart();
  }

  app.scrollTop = record.scroll;
  scheduleThumbnails();
}

function createGallery(code, item, signal) {
  const wrapper = element("section");
  wrapper.setAttribute("aria-label", "Фотографии вещи");

  const gallery = element("div", "gallery");
  const slides = [];

  for (let n = 1; n <= item.p; n += 1) {
    const slide = element("div", "gallery-slide");
    slide.setAttribute("role", "group");
    slide.setAttribute("aria-label", `Фото ${n} из ${item.p}`);
    slides.push({ node: slide, loaded: false });
    gallery.append(slide);
  }

  // URL совпадает с превью в ленте: уже загруженное изображение берётся
  // из браузерного кэша, не дожидаясь большого фото.
  const previewUrl = thumbUrl(code, item);
  if (slides[0] && previewUrl) {
    const preview = element("img", "gallery-preview");
    preview.alt = "";
    preview.decoding = "async";
    preview.addEventListener("error", () => {
      preview.hidden = true;
    }, { once: true, signal });
    slides[0].node.append(preview);
    preview.src = previewUrl;
  }

  const controls = element("div", "gallery-controls");
  const previous = button("←", "icon-button");
  previous.setAttribute("aria-label", "Предыдущее фото");

  const next = button("→", "icon-button");
  next.setAttribute("aria-label", "Следующее фото");

  const counter = element("p", "gallery-counter");
  counter.setAttribute("aria-live", "polite");
  counter.setAttribute("aria-atomic", "true");

  controls.append(previous, counter, next);
  wrapper.append(gallery, controls);

  let current = 0;
  let frame = 0;

  function loadPhoto(index) {
    const slide = slides[index];
    if (!slide || slide.loaded) return;
    slide.loaded = true;

    const image = element("img", "gallery-photo");
    image.alt = `${item.n} — фото ${index + 1}`;
    image.decoding = "async";

    const fail = () => {
      image.hidden = true;
      slide.node.classList.add("has-error");
      if (index === 0 && previewUrl) {
        slide.node.append(element("p", "gallery-error", "Фото недоступно"));
      } else {
        slide.node.append(fallback(code));
      }
    };

    image.addEventListener("load", () => {
      slide.node.classList.add("is-ready");
    }, { once: true, signal });
    image.addEventListener("error", fail, { once: true, signal });
    slide.node.append(image);

    const url = photoUrl(code, item, index + 1);
    if (url) image.src = url;
    else fail();
  }

  function update(index) {
    current = Math.max(0, Math.min(item.p - 1, index));
    counter.textContent = `${current + 1} / ${item.p}`;
    counter.setAttribute("aria-label", `Фото ${current + 1} из ${item.p}`);
    previous.disabled = current === 0;
    next.disabled = current === item.p - 1;
    previous.hidden = next.hidden = item.p === 1;

    loadPhoto(current);
    loadPhoto(current - 1);
    loadPhoto(current + 1);
  }

  function move(direction) {
    const target = Math.max(0, Math.min(item.p - 1, current + direction));
    loadPhoto(target);
    gallery.scrollTo({
      left: target * gallery.clientWidth,
      behavior: reducedMotion.matches ? "auto" : "smooth",
    });
  }

  previous.addEventListener("click", () => move(-1), { signal });
  next.addEventListener("click", () => move(1), { signal });

  gallery.addEventListener("scroll", () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (gallery.clientWidth === 0) return;
      const index = Math.round(gallery.scrollLeft / gallery.clientWidth);
      if (index !== current) update(index);
    });
  }, { passive: true, signal });

  const onResize = () => {
    if (gallery.clientWidth > 0) {
      gallery.scrollTo({ left: current * gallery.clientWidth, behavior: "auto" });
    }
  };

  let resizeObserver = null;
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(gallery);
  } else {
    window.addEventListener("resize", onResize, { signal });
  }

  update(0);

  return {
    node: wrapper,
    cleanup() {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      for (const image of gallery.querySelectorAll("img")) {
        image.removeAttribute("src");
      }
    },
  };
}

function closeLayer() {
  if (!dialog.open) return;

  layerCleanup?.();
  layerCleanup = null;
  layerCartSync = null;
  layerCode = null;

  dialog.close();
  dialog.replaceChildren();
  app.classList.remove("is-covered");
  app.scrollTop = coveredScroll;

  if (returnFocus?.isConnected) {
    returnFocus.focus({ preventScroll: true });
  }
  returnFocus = null;
  scheduleThumbnails();
}

function openLayer(code) {
  if (dialog.open && layerCode === code) return;

  const wasOpen = dialog.open;
  layerCleanup?.();
  layerCartSync = null;
  dialog.replaceChildren();

  if (!wasOpen) {
    returnFocus = document.activeElement;
    coveredScroll = app.scrollTop;
  }

  layerCode = code;
  disconnectFeed();

  // Освобождаем сеть для фото карточки ещё до следующего кадра.
  for (const record of thumbnails) {
    if (record.status === "loading") cancelThumbnail(record);
  }

  const controller = new AbortController();
  const { signal } = controller;

  const bar = element("header", "dialog-bar");
  bar.append(element("p", "", "Avelio"), cartEntry());

  const close = button("×", "icon-button");
  close.setAttribute("aria-label", "Закрыть карточку");
  close.addEventListener("click", goBack, { signal });
  bar.append(close);

  const body = element("div", "dialog-body");
  const footer = element("footer", "dialog-footer");
  const item = catalog.itemByCode(code);
  let galleryCleanup = null;

  if (item) {
    const gallery = createGallery(code, item, signal);
    galleryCleanup = gallery.cleanup;
    body.append(gallery.node);

    const info = element("div", "item-info");
    const title = element("h1", "", item.n);
    title.id = "item-title";

    info.append(title, element("p", "product-code", `Код ${code}`));

    if (typeof item.s === "string" && item.s.trim() !== "") {
      info.append(element("p", "item-size", `Размер: ${item.s}`));
    }

    if (typeof item.d === "string" && item.d.trim() !== "") {
      info.append(element("p", "item-description", item.d));
    }

    body.append(info);

    const actions = element("div", "item-actions");
    const add = button("В корзину", "button cart-add");
    const limitNote = element("p", "muted cart-limit", "В корзине уже 150 вещей.");
    limitNote.id = "cart-limit-note";
    limitNote.hidden = true;

    layerCartSync = () => {
      const added = cartHas(cart, code);
      const full = !added && cart.items.length >= CART_LIMIT;
      add.textContent = added ? "В корзине" : "В корзину";
      add.classList.toggle("is-added", added);
      add.disabled = full;
      limitNote.hidden = !full;

      if (full) {
        add.setAttribute("aria-describedby", limitNote.id);
      } else {
        add.removeAttribute("aria-describedby", limitNote.id);
      }
    };

    add.addEventListener("click", () => {
      if (cartHas(cart, code)) {
        navigate(CART);
        return;
      }

      const next = cartAdd(cart, code);
      if (!cartHas(next, code)) return;

      changeCart(next);
      announce("Добавлено в корзину");
      try {
        telegram?.HapticFeedback?.impactOccurred("light");
      } catch {
        // Тактильный отклик необязателен.
      }
    }, { signal });

    actions.append(botLink("price", code, "button button-primary"), add);
    footer.append(actions, limitNote);
    layerCartSync();

    if (!botStartLink("price", code)) {
      footer.append(
        element("p", "muted", "Для этой вещи ссылка недоступна."),
        botLink("pick"),
      );
    }
  } else {
    const panel = statePanel(
      "Не нашли эту вещь",
      "Возможно, в ссылке есть ошибка. Весь каталог — на главной.",
      routeLink("На главную", HOME, "button"),
    );
    panel.querySelector("h1").id = "item-title";
    body.append(panel);
    footer.hidden = true;
  }

  dialog.append(bar, body, footer);
  app.classList.add("is-covered");

  if (!wasOpen) dialog.showModal();
  close.focus({ preventScroll: true });

  layerCleanup = () => {
    controller.abort();
    galleryCleanup?.();
  };
}

function renderCurrent() {
  announce("");

  if (!catalog) {
    syncChrome();
    return;
  }

  if (activeRoute.view === "item") {
    const background = activeState.background;
    const backgroundRoute = background?.route;
    const validBackground = backgroundRoute
      && ["home", "room", "section", "search", "cart"].includes(backgroundRoute.view);

    const route = validBackground ? backgroundRoute : HOME;
    const key = validBackground ? background.key : `background-${activeState.key}`;

    if (dialog.open && (base?.key !== key || base.hash !== formatRoute(route))) {
      closeLayer();
    }

    ensureBase(route, key);
    openLayer(activeRoute.code);
  } else {
    closeLayer();
    ensureBase(activeRoute, activeState.key);
    connectFeed();
  }

  syncChrome();
  scheduleThumbnails();
}

function commitSearch() {
  clearTimeout(searchTimer);
  if (!catalog || composing || dialog.open) return;

  const query = searchInput.value;
  if (query === "" && activeRoute.view !== "search") return;

  navigate(
    { view: "search", q: query },
    { replace: activeRoute.view === "search" },
  );
}

function scheduleSearch() {
  clearSearch.hidden = searchInput.value.length === 0;
  clearTimeout(searchTimer);
  if (!composing) searchTimer = window.setTimeout(commitSearch, 80);
}

async function loadCatalog() {
  if (loading || catalog) return;
  loading = true;
  searchInput.disabled = true;

  const panel = statePanel("Открываем каталог", "Мебель для вашего дома.");
  panel.prepend(element("p", "eyebrow", "Avelio"));
  panel.setAttribute("role", "status");
  main.replaceChildren(panel);

  try {
    const response = await fetch("data/catalog.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const nextCatalog = createCatalog(await response.json());
    const nextIndex = buildSearchIndex(nextCatalog);

    catalog = nextCatalog;
    searchIndex = nextIndex;

    const cleaned = pruneCart(cart);
    if (serializeCart(cleaned) !== serializeCart(cart)) {
      cart = cleaned;
      persistCart();
    }

    searchInput.disabled = false;
    renderCurrent();
  } catch {
    const retry = button("Повторить");
    retry.addEventListener("click", loadCatalog);

    const error = statePanel(
      "Не удалось загрузить каталог",
      "Попробуйте ещё раз.",
      retry,
    );
    error.setAttribute("role", "alert");
    main.replaceChildren(error);
  } finally {
    loading = false;
  }
}

document.addEventListener("click", (event) => {
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
  ) return;

  const link = event.target.closest?.("a");
  if (!link || link.target || link.hasAttribute("download")) return;

  if (link.dataset.bot) {
    event.preventDefault();
    openBotUrl(link.href, link);
    return;
  }

  if (link.dataset.route) {
    event.preventDefault();
    navigate(parseRoute(link.dataset.route));
  }
});

backButton.addEventListener("click", goBack);

dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  goBack();
});

searchInput.addEventListener("input", scheduleSearch);
searchInput.addEventListener("compositionstart", () => {
  composing = true;
  clearTimeout(searchTimer);
});
searchInput.addEventListener("compositionend", () => {
  composing = false;
  scheduleSearch();
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  commitSearch();
  searchInput.blur();
});

clearSearch.addEventListener("click", () => {
  clearTimeout(searchTimer);
  searchInput.value = "";
  clearSearch.hidden = true;
  navigate(HOME, { replace: true });
  searchInput.focus({ preventScroll: true });
});

app.addEventListener("scroll", scheduleThumbnails, { passive: true });
window.addEventListener("resize", scheduleThumbnails);
window.visualViewport?.addEventListener("resize", scheduleThumbnails);

if ("ResizeObserver" in window) {
  const thumbnailResizeObserver = new ResizeObserver(scheduleThumbnails);
  thumbnailResizeObserver.observe(app);
  thumbnailResizeObserver.observe(app.querySelector(".header"));
}

window.addEventListener("popstate", onHistoryChange);
window.addEventListener("hashchange", onHistoryChange);

if (telegram) {
  telegramCall("ready");
  telegramCall("expand");
  telegramCall("disableVerticalSwipes");
  telegramCall("setHeaderColor", BG);
  telegramCall("setBackgroundColor", BG);
  telegramCall("setBottomBarColor", BG);

  try {
    telegram.BackButton?.onClick(goBack);
  } catch {
    // Ошибка API не блокирует остальные переходы.
  }
}

handledLocation = `${activeState.key}:${location.hash}`;
writeLocalCart(serializeCart(cart));
syncChrome();
restoreCloudCart();
loadCatalog();
