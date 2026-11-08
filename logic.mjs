export const BOT_USERNAME = "avelio_premium_bot";

const CODE_PATTERN = /^[A-Za-z]+-[0-9]+$/;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const START_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalCode(code) {
  return typeof code === "string" && CODE_PATTERN.test(code)
    ? code.toUpperCase()
    : null;
}

function validId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function normalize(text) {
  if (typeof text !== "string") return "";

  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/([0-9])\s*[×хx]\s*(?=[0-9])/g, "$1 ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function createCatalog(json) {
  function check(condition, message) {
    if (!condition) throw new TypeError(`catalog.json: ${message}`);
  }

  check(isRecord(json), "ожидается объект");
  check(isText(json.v), "v: ожидается непустая строка");
  check(Array.isArray(json.rooms), "rooms: ожидается массив");
  check(Array.isArray(json.sections), "sections: ожидается массив");
  check(isRecord(json.items), "items: ожидается объект");

  const items = Object.create(null);

  for (const [code, item] of Object.entries(json.items)) {
    check(
      canonicalCode(code) === code,
      `items.${code}: ожидается код вида PL-001 в верхнем регистре`,
    );
    check(isRecord(item), `items.${code}: ожидается объект`);
    check(isText(item.n), `items.${code}.n: ожидается непустая строка`);

    for (const field of ["s", "d"]) {
      check(
        !Object.prototype.hasOwnProperty.call(item, field)
          || typeof item[field] === "string",
        `items.${code}.${field}: ожидается строка`,
      );
    }

    for (const field of ["p", "tw", "th"]) {
      check(
        Number.isSafeInteger(item[field]) && item[field] > 0,
        `items.${code}.${field}: ожидается положительное целое число`,
      );
    }

    check(isText(item.v), `items.${code}.v: ожидается непустая строка`);
    items[code] = Object.freeze({ ...item });
  }

  const sectionsById = new Map();
  const sectionsByCode = new Map();
  const orderedCodes = [];

  const sections = json.sections.map((source, position) => {
    const path = `sections[${position}]`;
    check(isRecord(source), `${path}: ожидается объект`);
    check(validId(source.id), `${path}.id: недопустимый идентификатор`);
    check(!sectionsById.has(source.id), `${path}: повтор раздела ${source.id}`);
    check(isText(source.name), `${path}.name: ожидается непустая строка`);
    check(Array.isArray(source.items), `${path}.items: ожидается массив`);

    const section = Object.freeze({
      id: source.id,
      name: source.name,
      items: Object.freeze([...source.items]),
    });

    for (const code of section.items) {
      check(
        typeof code === "string"
          && Object.prototype.hasOwnProperty.call(items, code),
        `${path}.items: неизвестный код ${String(code)}`,
      );
      check(!sectionsByCode.has(code), `${path}.items: повтор вещи ${code}`);
      sectionsByCode.set(code, section);
      orderedCodes.push(code);
    }

    sectionsById.set(section.id, section);
    return section;
  });

  for (const code of Object.keys(items)) {
    check(sectionsByCode.has(code), `items.${code}: вещь не включена в раздел`);
  }

  const roomsById = new Map();
  const rooms = json.rooms.map((source, position) => {
    const path = `rooms[${position}]`;
    check(isRecord(source), `${path}: ожидается объект`);
    check(
      validId(source.id) && source.id !== "all",
      `${path}.id: недопустимый или зарезервированный идентификатор`,
    );
    check(!roomsById.has(source.id), `${path}: повтор комнаты ${source.id}`);
    check(isText(source.name), `${path}.name: ожидается непустая строка`);
    check(Array.isArray(source.sections), `${path}.sections: ожидается массив`);

    const seen = new Set();
    for (const id of source.sections) {
      check(sectionsById.has(id), `${path}.sections: неизвестный раздел ${id}`);
      check(!seen.has(id), `${path}.sections: повтор раздела ${id}`);
      seen.add(id);
    }

    const room = Object.freeze({
      id: source.id,
      name: source.name,
      sections: Object.freeze([...source.sections]),
    });
    roomsById.set(room.id, room);
    return room;
  });

  Object.freeze(items);
  Object.freeze(sections);
  Object.freeze(rooms);

  return Object.freeze({
    rooms,
    sections,
    items,

    sectionById(id) {
      return sectionsById.get(id);
    },

    itemByCode(code) {
      return items[canonicalCode(code)];
    },

    sectionOfItem(code) {
      return sectionsByCode.get(canonicalCode(code));
    },

    roomSections(roomId) {
      const room = roomsById.get(roomId);
      return room
        ? room.sections.map((id) => sectionsById.get(id))
        : [...sections];
    },

    // Как sections[].items и search(): возвращает коды, а не метаданные.
    itemsOfSection(id) {
      return [...(sectionsById.get(id)?.items ?? [])];
    },

    allCodes() {
      return [...orderedCodes];
    },
  });
}

function words(text) {
  const value = normalize(text);
  return value ? [...new Set(value.split(" "))] : [];
}

// Не отрезаем произвольные две буквы: «столы» -> «стол», не «сто».
// Корень остаётся длиной не менее четырёх букв.
function wordStem(word) {
  if (word.length < 5 || !/^[а-я]+$/.test(word)) return word;
  const stem = word.replace(
    /(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ов|ев|ам|ям|ах|ях|ом|ем|ую|юю|ья|[аеиоуыэюяь])$/,
    "",
  );
  return stem.length >= 4 ? stem : word;
}

function matchesWord(field, term) {
  return field.some(
    (word) => word.startsWith(term.text) || word.startsWith(term.stem),
  );
}

function matchesRoomWord(field, term) {
  return field.some(
    (word) => word.stem === term.stem
      || (term.text.length >= word.stem.length
        && word.text.startsWith(term.text)),
  );
}

// Строковое представление целого избегает потери точности длинных номеров.
function numberKey(digits) {
  return digits.replace(/^0+/, "") || "0";
}

export function buildSearchIndex(catalog) {
  const roomNames = new Map();

  for (const room of catalog.rooms) {
    for (const id of room.sections) {
      if (!roomNames.has(id)) roomNames.set(id, []);
      roomNames.get(id).push(room.name);
    }
  }

  const roomWords = new Map();
  const emptyRoomWords = Object.freeze([]);

  for (const [id, names] of roomNames) {
    roomWords.set(id, Object.freeze(
      words(names.join(" ")).map((text) => Object.freeze({
        text,
        stem: wordStem(text),
      })),
    ));
  }

  const entries = catalog.allCodes().map((code) => {
    const item = catalog.itemByCode(code);
    const section = catalog.sectionOfItem(code);
    const [prefix, digits] = code.split("-");
    const dimensions = (item.s ?? "").match(/[0-9]+(?:[.,][0-9]+)?/g) ?? [];

    return Object.freeze({
      code,
      prefix: prefix.toLowerCase(),
      number: numberKey(digits),
      name: Object.freeze(words(item.n)),
      context: Object.freeze(words(section.name)),
      rooms: roomWords.get(section.id) ?? emptyRoomWords,
      description: Object.freeze(words(item.d)),
      dimensions: Object.freeze(
        dimensions.map((value) => Number(value.replace(",", "."))),
      ),
    });
  });

  return Object.freeze({ entries: Object.freeze(entries) });
}

function queryTerms(query) {
  const text = normalize(query);
  if (!text) return [];

  const tokens = text.split(" ");
  const terms = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const compact = /^([a-z]+)([0-9]+)$/.exec(token);

    if (compact) {
      terms.push({
        kind: "code",
        prefix: compact[1],
        number: numberKey(compact[2]),
      });
    } else if (/^[a-z]+$/.test(token) && /^[0-9]+$/.test(tokens[i + 1] ?? "")) {
      terms.push({
        kind: "code",
        prefix: token,
        number: numberKey(tokens[i + 1]),
      });
      i += 1;
    } else if (/^[0-9]+$/.test(token)) {
      terms.push({
        kind: "number",
        number: numberKey(token),
        value: Number(token),
      });
    } else {
      terms.push({ kind: "word", text: token, stem: wordStem(token) });
    }
  }

  return terms;
}

function termRank(entry, term) {
  if (term.kind === "code") {
    return entry.prefix === term.prefix && entry.number === term.number
      ? 1
      : -1;
  }

  if (term.kind === "number") {
    if (entry.number === term.number) return 1;
    if (
      Number.isFinite(term.value)
      && term.value >= 30
      && entry.dimensions.some((value) => Math.abs(value - term.value) <= 5)
    ) {
      return 5;
    }
    return -1;
  }

  if (/^[a-z]+$/.test(term.text) && entry.prefix.startsWith(term.text)) return 1;
  if (matchesWord(entry.name, term)) return 2;
  if (
    matchesWord(entry.context, term)
    || matchesRoomWord(entry.rooms, term)
  ) {
    return 3;
  }
  if (matchesWord(entry.description, term)) return 4;
  return -1;
}

export function search(index, query, { limit } = {}) {
  if (typeof query !== "string") return [];
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new RangeError("search: limit должен быть неотрицательным целым числом");
  }
  if (limit === 0) return [];

  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const exactCode = canonicalCode(query.trim());
  const buckets = Array.from({ length: 6 }, () => []);

  for (const entry of index.entries) {
    let rank = 0;
    let matched = true;

    for (const term of terms) {
      const current = termRank(entry, term);
      if (current < 0) {
        matched = false;
        break;
      }

      // Для запроса с И ранг определяется самым слабым обязательным
      // совпадением: «диван 220» по размеру слабее совпадения обоих слов в имени.
      rank = Math.max(rank, current);
    }

    if (matched) {
      buckets[entry.code === exactCode ? 0 : rank].push(entry.code);
    }
  }

  const result = buckets.flat();
  return limit === undefined ? result : result.slice(0, limit);
}

export function parseRoute(hash) {
  const home = { view: "home" };
  if (typeof hash !== "string" || hash === "" || hash === "#" || hash === "#/") {
    return home;
  }

  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "/") return home;

  const match = /^\/([rsiq])\/([^/]*)$/.exec(path);
  if (!match) return home;

  let value;
  try {
    value = decodeURIComponent(match[2]);
  } catch {
    return home;
  }

  switch (match[1]) {
    case "r":
      return validId(value) ? { view: "room", room: value } : home;
    case "s":
      return validId(value) ? { view: "section", section: value } : home;
    case "i": {
      const code = canonicalCode(value);
      return code ? { view: "item", code } : home;
    }
    case "q":
      return { view: "search", q: value };
    default:
      return home;
  }
}

export function formatRoute(route) {
  if (!isRecord(route)) return "#/";

  switch (route.view) {
    case "home":
      return "#/";
    case "room":
      return validId(route.room) ? `#/r/${route.room}` : "#/";
    case "section":
      return validId(route.section) ? `#/s/${route.section}` : "#/";
    case "item": {
      const code = canonicalCode(route.code);
      return code ? `#/i/${code}` : "#/";
    }
    case "search":
      if (typeof route.q !== "string") return "#/";
      try {
        return `#/q/${encodeURIComponent(route.q)}`;
      } catch {
        return "#/";
      }
    default:
      return "#/";
  }
}

export function routeFromStartParam(param) {
  if (typeof param !== "string" || !START_PATTERN.test(param)) return null;

  const directCode = canonicalCode(param);
  if (directCode) return { view: "item", code: directCode };

  const kind = param.slice(0, 2);
  const value = param.slice(2);

  if (kind === "i_") {
    const code = canonicalCode(value);
    return code ? { view: "item", code } : null;
  }
  if (kind === "s_" && validId(value)) {
    return { view: "section", section: value };
  }
  if (kind === "r_" && validId(value)) {
    return { view: "room", room: value };
  }
  return null;
}

export function botStartLink(kind, code) {
  let param;

  if (kind === "pick") {
    param = "pick";
  } else if (kind === "price") {
    const canonical = canonicalCode(code);
    if (!canonical) return null;
    param = `price_${canonical}`;
  } else {
    return null;
  }

  return START_PATTERN.test(param)
    ? `https://t.me/${BOT_USERNAME}?start=${param}`
    : null;
}

function imageParts(code, item) {
  const canonical = canonicalCode(code);
  if (!canonical || !isRecord(item) || !isText(item.v)) return null;
  try {
    return { code: canonical, version: encodeURIComponent(item.v) };
  } catch {
    return null;
  }
}

export function thumbUrl(code, item) {
  const parts = imageParts(code, item);
  return parts ? `img/t/${parts.code}.webp?v=${parts.version}` : null;
}

export function photoUrl(code, item, n) {
  const parts = imageParts(code, item);
  if (
    !parts
    || !Number.isSafeInteger(item.p)
    || item.p < 1
    || !Number.isSafeInteger(n)
    || n < 1
    || n > item.p
  ) {
    return null;
  }
  return `img/p/${parts.code}/${n}.webp?v=${parts.version}`;
}

export function pageSlice(list, page, size) {
  if (
    !Array.isArray(list)
    || !Number.isSafeInteger(page)
    || page < 0
    || !Number.isSafeInteger(size)
    || size < 1
  ) {
    return [];
  }

  const start = page * size;
  if (!Number.isSafeInteger(start) || start >= list.length) return [];
  return list.slice(start, start + size);
}

export function plural(n, one, few, many) {
  if (typeof n !== "number" || !Number.isFinite(n)) return many;
  const value = Math.abs(n);
  if (!Number.isInteger(value)) return many;

  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = value % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
