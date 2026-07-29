#!/usr/bin/env node
/**
 * Мои финансы — backend синхронизации.
 * Чистый Node.js, без внешних зависимостей и без npm install
 * (SQLite — встроенный модуль node:sqlite, ничего ставить не нужно).
 *
 * Запуск:            node server.js
 * Добавить юзера:    node server.js adduser <логин> <пароль>
 * Сменить пароль:    node server.js passwd  <логин> <пароль>
 * Список юзеров:     node server.js users
 *
 * Переменные окружения:
 *   PORT           (по умолчанию 8787)   — порт
 *   HOST           (по умолчанию 127.0.0.1) — интерфейс (за nginx оставляем localhost)
 *   DATA_DIR       (по умолчанию ./data) — где хранить store.db (SQLite)
 *   FIN_USER / FIN_PASS              — при первом запуске создаст этого пользователя,
 *                                      если в базе ещё никого нет.
 *   ALLOWED_ORIGIN — источник, которому разрешён доступ к /api/* (CORS), напр.
 *                    https://example.com. Нужно, только если фронтенд когда-нибудь
 *                    будет отдаваться отдельно от этого сервера (сейчас не так —
 *                    сервер отдаёт и фронт, и API с одного домена, CORS не нужен).
 *   REGISTER_CODE  — если задан, /api/register требует этот код в поле "code".
 *                    Не задан (по умолчанию) — регистрация открыта всем.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const REGISTER_CODE = process.env.REGISTER_CODE || "";
const DB_PATH = path.join(DATA_DIR, "store.db");
const OLD_JSON_STORE = path.join(DATA_DIR, "store.json"); // старый формат — для одноразовой миграции
const APP_HTML = path.join(__dirname, "index.html");
const TOKEN_TTL = 60 * 24 * 60 * 60 * 1000; // 60 дней

// ---------- хранилище (SQLite) ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbIsNew = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL"); // конкурентные чтения не блокируют запись
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS states (
    username TEXT PRIMARY KEY REFERENCES users(username),
    data TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`);

// одноразовая миграция со старого формата (плоский store.json), если он есть и SQLite-базы ещё не было
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
  getUser: db.prepare("SELECT username, salt, hash FROM users WHERE username = ?"),
  countUsers: db.prepare("SELECT COUNT(*) AS n FROM users"),
  listUsers: db.prepare("SELECT username FROM users ORDER BY username"),
  upsertUser: db.prepare("INSERT INTO users (username, salt, hash) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, hash = excluded.hash"),
  ensureState: db.prepare("INSERT OR IGNORE INTO states (username, data, updated_at) VALUES (?, NULL, 0)"),
  getState: db.prepare("SELECT data, updated_at FROM states WHERE username = ?"),
  setState: db.prepare("INSERT INTO states (username, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"),
};

// ---------- пароли (scrypt, встроенный в Node) ----------
function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  const h = crypto.scryptSync(pw, salt, 64).toString("hex");
  const a = Buffer.from(h, "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setUser(username, password) {
  username = String(username).trim().toLowerCase();
  const { salt, hash } = hashPassword(password);
  stmt.upsertUser.run(username, salt, hash);
  stmt.ensureState.run(username);
}
function getUser(username) {
  return stmt.getUser.get(String(username || "").trim().toLowerCase());
}
function getState(username) {
  const row = stmt.getState.get(username);
  if (!row) return { data: null, updatedAt: 0 };
  return { data: row.data == null ? null : JSON.parse(row.data), updatedAt: row.updated_at };
}
function setState(username, data) {
  const updatedAt = Date.now();
  stmt.setState.run(username, JSON.stringify(data), updatedAt);
  return updatedAt;
}
// общая проверка логина/пароля — используется и CLI adduser, и /api/register
function validateCreds(username, password) {
  username = String(username || "").trim();
  password = String(password || "");
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return "Логин: 3-32 символа, латиница/цифры/._-";
  if (password.length < 6) return "Пароль: минимум 6 символов";
  return null;
}

// ---------- токены (в памяти) ----------
const tokens = new Map(); // token -> { user, exp }
function issueToken(user) {
  const t = crypto.randomBytes(32).toString("hex");
  tokens.set(t, { user, exp: Date.now() + TOKEN_TTL });
  return t;
}
function userFromToken(t) {
  const rec = tokens.get(t);
  if (!rec) return null;
  if (rec.exp < Date.now()) { tokens.delete(t); return null; }
  return rec.user;
}

// ---------- CLI ----------
const [, , cmd, arg1, arg2] = process.argv;
if (cmd === "adduser" || cmd === "passwd") {
  if (!arg1 || !arg2) { console.error("Использование: node server.js " + cmd + " <логин> <пароль>"); process.exit(1); }
  setUser(arg1, arg2);
  console.log((cmd === "adduser" ? "Пользователь создан/обновлён: " : "Пароль изменён: ") + arg1.toLowerCase());
  process.exit(0);
}
if (cmd === "users") {
  const rows = stmt.listUsers.all();
  console.log(rows.map(r => r.username).join("\n") || "(пусто)");
  process.exit(0);
}

// первичный сид из env
if (stmt.countUsers.get().n === 0 && process.env.FIN_USER && process.env.FIN_PASS) {
  setUser(process.env.FIN_USER, process.env.FIN_PASS);
  console.log("Создан первый пользователь из FIN_USER/FIN_PASS: " + process.env.FIN_USER.toLowerCase());
}
if (stmt.countUsers.get().n === 0) {
  console.log("[!] В базе нет пользователей. Зарегистрируйтесь на сайте или создайте через CLI: node server.js adduser <логин> <пароль>");
}

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
function bearer(req) {
  const h = req.headers["authorization"] || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
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

  // API: регистрация
  if (p === "/api/register" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      if (REGISTER_CODE && body.code !== REGISTER_CODE) return json(res, 401, { error: "bad code" });
      const err = validateCreds(body.username, body.password);
      if (err) return json(res, 400, { error: err });
      const username = String(body.username).trim().toLowerCase();
      if (getUser(username)) return json(res, 409, { error: "user exists" });
      setUser(username, body.password);
      return json(res, 200, { token: issueToken(username) });
    } catch { return json(res, 400, { error: "bad request" }); }
  }

  // API: логин
  if (p === "/api/login" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const u = getUser(body.username);
      if (!u || !verifyPassword(String(body.password || ""), u.salt, u.hash))
        return json(res, 401, { error: "bad credentials" });
      return json(res, 200, { token: issueToken(u.username) });
    } catch { return json(res, 400, { error: "bad request" }); }
  }

  // API: смена своего пароля (из профиля в интерфейсе)
  if (p === "/api/account/password" && req.method === "PUT") {
    const user = userFromToken(bearer(req));
    if (!user) return json(res, 401, { error: "unauthorized" });
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const u = getUser(user);
      if (!u || !verifyPassword(String(body.currentPassword || ""), u.salt, u.hash))
        return json(res, 401, { error: "bad credentials" });
      const err = validateCreds(user, body.newPassword);
      if (err) return json(res, 400, { error: err });
      setUser(user, body.newPassword);
      return json(res, 200, { ok: true });
    } catch { return json(res, 400, { error: "bad request" }); }
  }

  // API: состояние
  if (p === "/api/state") {
    const user = userFromToken(bearer(req));
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
});
