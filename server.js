#!/usr/bin/env node
/**
 * Мои финансы — backend синхронизации.
 * Чистый Node.js, без внешних зависимостей и без npm install.
 *
 * Запуск:            node server.js
 * Добавить юзера:    node server.js adduser <логин> <пароль>
 * Сменить пароль:    node server.js passwd  <логин> <пароль>
 * Список юзеров:     node server.js users
 *
 * Переменные окружения:
 *   PORT           (по умолчанию 8787)   — порт
 *   HOST           (по умолчанию 127.0.0.1) — интерфейс (за nginx оставляем localhost)
 *   DATA_DIR       (по умолчанию ./data) — где хранить store.json
 *   FIN_USER / FIN_PASS              — при первом запуске создаст этого пользователя,
 *                                      если в базе ещё никого нет.
 *   ALLOWED_ORIGIN — источник, которому разрешён доступ к /api/* (CORS), напр.
 *                    https://burning-house.online. Нужно, когда фронтенд отдаётся
 *                    отдельно (напр. GitHub Pages), а этот сервер — только API на
 *                    своём домене. Без переменной CORS-заголовки не отправляются
 *                    (подходит для варианта "фронт и API на одном домене").
 *   REGISTER_CODE  — если задан, /api/register требует этот код в поле "code"
 *                    (простая защита от случайной регистрации посторонних на
 *                    публично торчащем эндпоинте). Не задан — регистрация открыта всем.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const REGISTER_CODE = process.env.REGISTER_CODE || "";
const STORE = path.join(DATA_DIR, "store.json");
const APP_HTML = path.join(__dirname, "index.html");
const TOKEN_TTL = 60 * 24 * 60 * 60 * 1000; // 60 дней

// ---------- хранилище ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); }
  catch { return { users: {}, states: {} }; }
}
function saveStore(s) {
  const tmp = STORE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STORE); // атомарная запись
}
let store = loadStore();

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
  store.users[username] = { salt, hash };
  if (!store.states[username]) store.states[username] = { data: null, updatedAt: 0 };
  saveStore(store);
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
  console.log(Object.keys(store.users).join("\n") || "(пусто)");
  process.exit(0);
}

// первичный сид из env
if (Object.keys(store.users).length === 0 && process.env.FIN_USER && process.env.FIN_PASS) {
  setUser(process.env.FIN_USER, process.env.FIN_PASS);
  console.log("Создан первый пользователь из FIN_USER/FIN_PASS: " + process.env.FIN_USER.toLowerCase());
}
if (Object.keys(store.users).length === 0) {
  console.log("[!] В базе нет пользователей. Создайте: node server.js adduser <логин> <пароль>");
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
// Отдаём ТОЛЬКО index.html и файлы из assets/. store.json, server.js и т.п. недоступны из вне.
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

  // CORS: нужен, когда фронтенд отдаётся с другого домена (напр. GitHub Pages),
  // а этот сервер — только API. Без ALLOWED_ORIGIN заголовки не шлём (тогда
  // работает только сценарий "фронт и API на одном домене", как раньше).
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
      store.users = loadStore().users; // подхватить пользователей, добавленных параллельно через CLI
      if (store.users[username]) return json(res, 409, { error: "user exists" });
      setUser(username, body.password);
      return json(res, 200, { token: issueToken(username) });
    } catch { return json(res, 400, { error: "bad request" }); }
  }

  // API: логин
  if (p === "/api/login" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const username = String(body.username || "").trim().toLowerCase();
      // подхватываем пользователей, добавленных через CLI (adduser/passwd) пока сервер уже запущен —
      // иначе `docker exec ... adduser` или запуск CLI рядом с systemd-сервисом молча не сработает без рестарта
      store.users = loadStore().users;
      const u = store.users[username];
      if (!u || !verifyPassword(String(body.password || ""), u.salt, u.hash))
        return json(res, 401, { error: "bad credentials" });
      return json(res, 200, { token: issueToken(username) });
    } catch { return json(res, 400, { error: "bad request" }); }
  }

  // API: состояние
  if (p === "/api/state") {
    const user = userFromToken(bearer(req));
    if (!user) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET") {
      const st = store.states[user] || { data: null, updatedAt: 0 };
      return json(res, 200, st);
    }
    if (req.method === "PUT") {
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        if (typeof body.data !== "object" || body.data === null) return json(res, 400, { error: "no data" });
        store.states[user] = { data: body.data, updatedAt: Date.now() };
        saveStore(store);
        return json(res, 200, { ok: true, updatedAt: store.states[user].updatedAt });
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
  console.log(`Мои финансы: http://${HOST}:${PORT}  (данные: ${STORE})`);
});
