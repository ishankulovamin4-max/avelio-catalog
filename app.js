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
} from "./logic.mjs?v=cf6c65ee";

const BG = "#101112";
const PAGE_SIZE = 24;
const HOME = { view: "home" };

const app = document.querySelector("#app");
const main = document.querySelector("#main");
const dialog = document.querySelector("#item-dialog");
const searchForm = document.querySelector("#search-form");
const searchInput = document.querySelector("#search");
const clearSearch = document.querySelector("#search-clear");
const backButton = document.querySelector("#back");
const announcement = document.querySelector("#announcement");

const webApp = window.Telegram?.WebApp;
const telegram = webApp && typeof webApp.initData === "string"
  && webApp.initData.trim() !== "" ? webApp : null;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const snapshots = new Map();

let serial = 0;
let catalog = null;
let searchIndex = null;
let loading = false;
let base = null;
let searchTimer = 0;
let composing = false;
let layerCleanup = null;
let layerCode = null;
let returnFocus = null;
let coveredScroll = 0;

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
    // Веб-кнопка «Назад» остаётся доступной.
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
  backButton.hidden = activeRoute.view === "home";

  const visibleRoute = activeRoute.view === "item" ? base?.route : activeRoute;
  const query = visibleRoute?.view === "search" ? visibleRoute.q : "";

  if (searchInput.value !== query) searchInput.value = query;
  clearSearch.hidden = searchInput.value.length === 0;
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

function thumbnail(code, item) {
  const frame = element("div", "thumb");
  frame.style.aspectRatio = `${item.tw} / ${item.th}`;

  const missing = fallback(code);
  missing.hidden = true;

  const image = element("img");
  image.alt = "";
  image.width = item.tw;
  image.height = item.th;
  image.loading = "lazy";
  image.decoding = "async";

  const fail = () => {
    image.hidden = true;
    missing.hidden = false;
  };

  image.addEventListener("error", fail, { once: true });
  frame.append(image, missing);

  const url = thumbUrl(code, item);
  if (url) image.src = url;
  else fail();

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
      empty.style.aspectRatio = "3 / 2";
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

function ensureBase(route, key) {
  const hash = formatRoute(route);
  if (base?.key === key && base.hash === hash) return;

  disconnectFeed();
  main.replaceChildren();

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
  }

  app.scrollTop = record.scroll;
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

    const image = element("img");
    image.alt = `${item.n} — фото ${index + 1}`;
    image.decoding = "async";

    const missing = fallback(code);
    missing.hidden = true;

    const fail = () => {
      image.hidden = true;
      missing.hidden = false;
    };

    image.addEventListener("error", fail, { once: true, signal });
    slide.node.append(image, missing);

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

    loadPhoto(current - 1);
    loadPhoto(current);
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
    },
  };
}

function closeLayer() {
  if (!dialog.open) return;

  layerCleanup?.();
  layerCleanup = null;
  layerCode = null;

  dialog.close();
  dialog.replaceChildren();
  app.classList.remove("is-covered");
  app.scrollTop = coveredScroll;

  if (returnFocus?.isConnected) {
    returnFocus.focus({ preventScroll: true });
  }
  returnFocus = null;
}

function openLayer(code) {
  if (dialog.open && layerCode === code) return;

  const wasOpen = dialog.open;
  layerCleanup?.();
  dialog.replaceChildren();

  if (!wasOpen) {
    returnFocus = document.activeElement;
    coveredScroll = app.scrollTop;
  }

  layerCode = code;
  disconnectFeed();

  const controller = new AbortController();
  const { signal } = controller;

  const bar = element("header", "dialog-bar");
  bar.append(element("p", "", "Avelio"));

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
    footer.append(botLink("price", code, "button button-primary"));

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
      && ["home", "room", "section", "search"].includes(backgroundRoute.view);

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

  if (link.dataset.bot && telegram) {
    try {
      telegram.openTelegramLink(link.href);
      event.preventDefault();
    } catch {
      // Если клиент не поддерживает переход, работает обычная ссылка.
    }
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
  searchInput.value = "";
  clearSearch.hidden = true;
  commitSearch();
  searchInput.focus({ preventScroll: true });
});

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
    // Встроенная в страницу навигация не зависит от Telegram BackButton.
  }
}

handledLocation = `${activeState.key}:${location.hash}`;
syncChrome();
loadCatalog();
