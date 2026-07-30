#!/usr/bin/env node
/**
 * Мои финансы — backend синхронизации.
 * Чистый Node.js, без внешних зависимостей и без npm install
 * (SQLite — встроенный модуль node:sqlite, ничего ставить не нужно).
 *
 * Пользователями этот сервис больше не управляет: аккаунты, пароли и вход живут
 * в общем auth-сервисе (auth.burninghouse.ru). Сюда приходит уже подписанный
 * access-токен, подпись которого проверяется ЛОКАЛЬНО по JWKS — сетевого запроса
 * в auth на каждый вызов нет, и его недоступность не роняет синхронизацию.
 *
 * Запуск:            node server.js
 * Список состояний:  node server.js states
 *
 * Переменные окружения:
 *   PORT           (по умолчанию 8787)      — порт
 *   HOST           (по умолчанию 127.0.0.1) — интерфейс (за nginx оставляем localhost)
 *   DATA_DIR       (по умолчанию ./data)    — где хранить store.db (SQLite)
 *   AUTH_ISSUER    ОБЯЗАТЕЛЬНО — адрес auth-сервиса, напр. https://auth.burninghouse.ru.
 *                  Он же claim iss в токенах: сверяется побайтово.
 *   AUTH_CLIENT_ID (по умолчанию finance)   — идентификатор этого сервиса в auth
 *   AUTH_BASE      (по умолчанию = AUTH_ISSUER) — адрес, на который фронт уводит
 *                  пользователя на вход. Отличается от ISSUER только если сервер
 *                  ходит в auth по внутреннему адресу, а браузер — по внешнему.
 *   AUTH_JWKS_URL  (по умолчанию AUTH_ISSUER + /.well-known/jwks.json)
 *   AUTH_CLOCK_SKEW (по умолчанию 30) — допуск на расхождение часов, секунды.
 *                  Настолько же токен переживает свой срок, поэтому не завышайте.
 *   ALLOWED_ORIGIN — источник, которому разрешён доступ к /api/* (CORS). Нужен,
 *                    только если фронтенд отдаётся отдельно от этого сервера
 *                    (сейчас не так — фронт и API на одном домене).
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const DB_PATH = path.join(DATA_DIR, "store.db");
const OLD_JSON_STORE = path.join(DATA_DIR, "store.json"); // самый старый формат — для одноразовой миграции
const APP_HTML = path.join(__dirname, "index.html");

const AUTH_ISSUER = (process.env.AUTH_ISSUER || "").replace(/\/+$/, "");
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "finance";
const AUTH_BASE = (process.env.AUTH_BASE || AUTH_ISSUER).replace(/\/+$/, "");

// ---------- хранилище (SQLite) ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbIsNew = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL"); // конкурентные чтения не блокируют запись
db.exec(`
  CREATE TABLE IF NOT EXISTS states_v2 (
    user_id    TEXT PRIMARY KEY,
    username   TEXT,
    data       TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  -- Таблицы users и states остались от времён, когда сервис сам держал аккаунты.
  -- Их не трогаем: это резервная копия на случай, если с переездом что-то пойдёт не так.
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS states (
    username TEXT PRIMARY KEY,
    data TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`);
// Отметка о переносе строки в states_v2 — чтобы не переносить дважды и при этом
// ничего не удалять. На свежей базе колонка уже есть, на старой добавляется здесь.
try { db.exec("ALTER TABLE states ADD COLUMN migrated_to TEXT"); } catch { /* уже есть */ }

// одноразовая миграция с самого старого формата (плоский store.json)
if (dbIsNew && fs.existsSync(OLD_JSON_STORE)) {
  try {
    const old = JSON.parse(fs.readFileSync(OLD_JSON_STORE, "utf8"));
    const insUser = db.prepare("INSERT OR REPLACE INTO users (username, salt, hash) VALUES (?, ?, ?)");
    const insState = db.prepare("INSERT OR REPLACE INTO states (username, data, updated_at) VALUES (?, ?, ?)");
    let n = 0;
    for (const [username, u] of Object.entries(old.users || {})) {
      insUser.run(username, u.salt, u.hash);
      const st = (old.states || {})[username] || { data: null, updatedAt: 0 };
      insState.run(username, st.data == null ? null : JSON.stringify(st.data), st.updatedAt || 0);
      n++;
    }
    fs.renameSync(OLD_JSON_STORE, OLD_JSON_STORE + ".migrated");
    console.log(`Миграция со старого store.json завершена: перенесено пользователей — ${n}. Старый файл сохранён как store.json.migrated.`);
  } catch (e) {
    console.error("Не удалось мигрировать старый store.json (продолжаю с пустой базой):", e.message);
  }
}

const stmt = {
  // Ссылку на саму базу держим здесь намеренно. После инициализации `db` больше
  // нигде в коде не упоминается, и V8 вправе выбросить эту переменную из
  // контекста модуля — тогда финализатор DatabaseSync закроет базу, и все
  // подготовленные запросы падают с «statement has been finalized». Поскольку
  // stmt захвачен обработчиками запросов, база через него остаётся достижимой.
  db,
  getState: db.prepare("SELECT data, updated_at FROM states_v2 WHERE user_id = ?"),
  setState: db.prepare("INSERT INTO states_v2 (user_id, username, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, data = excluded.data, updated_at = excluded.updated_at"),
  listStates: db.prepare("SELECT user_id, username, LENGTH(data) AS size, updated_at FROM states_v2 ORDER BY updated_at DESC"),
  legacyState: db.prepare("SELECT data, updated_at FROM states WHERE username = ? AND migrated_to IS NULL"),
  markLegacyMigrated: db.prepare("UPDATE states SET migrated_to = ? WHERE username = ? AND migrated_to IS NULL"),
  countLegacy: db.prepare("SELECT COUNT(*) AS n FROM states WHERE migrated_to IS NULL"),
};

/**
 * Данные пользователя. Раньше строки лежали под логином — теперь под стабильным
 * user_id из auth. Переносим при первом же обращении: логин есть в токене
 * (preferred_username), так что никаких ручных маппингов и простоя не нужно.
 */
function getState(user) {
  const row = stmt.getState.get(user.id);
  if (row) return { data: row.data == null ? null : JSON.parse(row.data), updatedAt: row.updated_at };

  if (user.username) {
    const old = stmt.legacyState.get(user.username);
    if (old) {
      stmt.setState.run(user.id, user.username, old.data, old.updated_at);
      stmt.markLegacyMigrated.run(user.id, user.username);
      console.log(`Данные «${user.username}» перенесены на user_id ${user.id}`);
      return { data: old.data == null ? null : JSON.parse(old.data), updatedAt: old.updated_at };
    }
  }
  return { data: null, updatedAt: 0 };
}

function setState(user, data) {
  // Если пользователь пишет раньше, чем прочитал, — сначала доводим перенос до
  // конца. Иначе старая строка осталась бы неперенесённой и позже подменила бы
  // собой свежие данные.
  if (!stmt.getState.get(user.id)) getState(user);
  const updatedAt = Date.now();
  stmt.setState.run(user.id, user.username || null, JSON.stringify(data), updatedAt);
  return updatedAt;
}

// ---------- CLI ----------
const [, , cmd] = process.argv;
if (cmd === "states") {
  const rows = stmt.listStates.all();
  if (!rows.length) console.log("(пусто)");
  for (const r of rows) {
    console.log(`${(r.username || "—").padEnd(20)}  ${r.user_id}  ${String(r.size || 0).padStart(8)} байт  ${new Date(r.updated_at).toISOString().slice(0, 19).replace("T", " ")}`);
  }
  const pending = stmt.countLegacy.get().n;
  console.log(`\nЖдут переезда со старой таблицы states: ${pending}`);
  process.exit(0);
}
if (cmd) {
  console.error(`Неизвестная команда: ${cmd}\n\nДоступно: states\nАккаунтами теперь заведует auth-сервис — см. там adduser/passwd/users.`);
  process.exit(1);
}

// ---------- авторизация ----------
if (!AUTH_ISSUER) {
  console.error("Не задан AUTH_ISSUER — без него нечем проверять токены. Укажите адрес auth-сервиса, напр. AUTH_ISSUER=https://auth.burninghouse.ru");
  process.exit(1);
}
const auth = require("./auth-client")({
  issuer: AUTH_ISSUER,
  audience: AUTH_CLIENT_ID,
  jwksUrl: process.env.AUTH_JWKS_URL,
  // Допуск на расхождение часов, секунды. Ровно настолько же токен переживает
  // свой exp, поэтому по умолчанию он небольшой.
  clockSkew: process.env.AUTH_CLOCK_SKEW == null ? undefined : parseInt(process.env.AUTH_CLOCK_SKEW, 10),
});
auth.warmup();

// ---------- утилиты HTTP ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else data += c; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function serveApp(res) {
  try {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(APP_HTML));
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("index.html не найден рядом с server.js");
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".woff2": "font/woff2"
};
const ASSETS_DIR = path.join(__dirname, "assets");
// Отдаём ТОЛЬКО index.html и файлы из assets/. store.db, server.js и т.п. недоступны из вне.
function serveStatic(res, pathname) {
  if (pathname !== "/index.html" && !pathname.startsWith("/assets/")) return false;
  const file = path.join(__dirname, path.normalize(pathname).replace(/^([\\/])+/, ""));
  const allowed = file === APP_HTML || file === ASSETS_DIR || file.startsWith(ASSETS_DIR + path.sep);
  if (!allowed) return false;
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

// ---------- сервер ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  // CORS: нужен, только если фронтенд когда-нибудь будет отдаваться с другого домена.
  // Без ALLOWED_ORIGIN заголовки не шлём (обычный случай — всё на одном домене).
  if (ALLOWED_ORIGIN && p.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }

  // Куда фронту идти за входом. Отдаём с сервера, чтобы адрес auth-сервиса
  // не был зашит в статику и менялся одной переменной окружения.
  if (p === "/api/config") {
    return json(res, 200, { authBase: AUTH_BASE, clientId: AUTH_CLIENT_ID });
  }

  // API: состояние — единственный защищённый ресурс
  if (p === "/api/state") {
    const user = await auth.userFromRequest(req);
    if (!user) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET") {
      return json(res, 200, getState(user));
    }
    if (req.method === "PUT") {
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        if (typeof body.data !== "object" || body.data === null) return json(res, 400, { error: "no data" });
        const updatedAt = setState(user, body.data);
        return json(res, 200, { ok: true, updatedAt });
      } catch { return json(res, 400, { error: "bad request" }); }
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // health-check
  if (p === "/api/health") return json(res, 200, { ok: true });

  // статика (css/js) и приложение (SPA-стиль fallback)
  if (req.method === "GET") {
    if (p !== "/" && serveStatic(res, p)) return;
    return serveApp(res);
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`Мои финансы: http://${HOST}:${PORT}  (данные: ${DB_PATH})`);
  console.log(`Авторизация: ${AUTH_ISSUER} (клиент «${AUTH_CLIENT_ID}»)`);
  const pending = stmt.countLegacy.get().n;
  if (pending) console.log(`Со старой схемы ещё не переехали данные ${pending} пользовател(я/ей) — перенесутся сами при их первом входе.`);
});
