#!/usr/bin/env node
/**
 * Мои финансы — backend.
 * Чистый Node.js, без внешних зависимостей и без npm install
 * (SQLite — встроенный модуль node:sqlite, ничего ставить не нужно).
 *
 * Пользователями этот сервис не управляет: аккаунты, пароли и вход живут
 * в общем auth-сервисе (auth.burninghouse.ru). Сюда приходит уже подписанный
 * access-токен, подпись которого проверяется ЛОКАЛЬНО по JWKS — сетевого запроса
 * в auth на каждый вызов нет, и его недоступность не роняет синхронизацию.
 *
 * API — версионированный REST (/api/v1/...), сущности хранятся нормализованными
 * таблицами (не одним JSON-блобом) — см. API.md. Это сделано, чтобы данными
 * могли пользоваться не только сам фронтенд «Финансов», но и другие сервисы
 * BurningHouse (по тому же access-токену).
 *
 * Запуск:            node server.js
 * Список аккаунтов:  node server.js states
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
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { checkAdminKey, createAdminLog } = require("./admin-internal");

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const DB_PATH = path.join(DATA_DIR, "store.db");
const OLD_JSON_STORE = path.join(DATA_DIR, "store.json"); // самый старый формат — для одноразовой миграции
const APP_HTML = path.join(__dirname, "index.html");
// Публичная страница-калькулятор (без авторизации, для индексации) + её SEO-файлы.
// Отдаются как статика наравне с index.html — сами по себе не ходят в API.
const CALC_HTML = path.join(__dirname, "calculator.html");
const ROBOTS_TXT = path.join(__dirname, "robots.txt");
const SITEMAP_XML = path.join(__dirname, "sitemap.xml");

const AUTH_ISSUER = (process.env.AUTH_ISSUER || "").replace(/\/+$/, "");
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "finance";
const AUTH_BASE = (process.env.AUTH_BASE || AUTH_ISSUER).replace(/\/+$/, "");

// ---------- хранилище (SQLite) ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbIsNew = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL"); // конкурентные чтения не блокируют запись
db.exec(`
  -- Нормализованные сущности (v3). Ключ — user_id (стабильный UUID из auth), не логин.
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    cat TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    fixed_id TEXT,
    refund_for TEXT,
    card_id TEXT,
    card_repay TEXT,
    piggy_id TEXT,
    asset_id TEXT,
    goal_id TEXT,
    debt_repay TEXT,
    asset_qty REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);

  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    target REAL NOT NULL,
    saved REAL NOT NULL DEFAULT 0,
    emoji TEXT NOT NULL DEFAULT '🎯',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);

  CREATE TABLE IF NOT EXISTS debts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT,              -- 'card' | NULL (обычный кредит/рассрочка)
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🏦',
    card_limit REAL,
    used REAL,
    total REAL,
    remaining REAL,
    monthly REAL,
    loan_type TEXT,          -- 'mortgage'|'consumer'|'auto'|'installment'|'other'|NULL — ярлык, на расчёты не влияет
    rate REAL,               -- % годовых, NULL = не указана
    start_date TEXT,
    payment_day INTEGER,     -- 1..31, для уведомлений
    notify_email INTEGER NOT NULL DEFAULT 0,
    notify_days_before INTEGER NOT NULL DEFAULT 3,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id);

  CREATE TABLE IF NOT EXISTS fixed_payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    amount REAL NOT NULL,
    days TEXT NOT NULL DEFAULT '[]',   -- JSON-массив чисел месяца, напр. [5,20]
    emoji TEXT NOT NULL DEFAULT '🏠',
    category TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fixed_user ON fixed_payments(user_id);

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '💰',
    amount REAL NOT NULL DEFAULT 0,
    ticker TEXT,
    qty REAL,
    last_price REAL,
    price_updated TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id);

  -- Одна строка на пользователя: настройки + флаг «уже перенесён с блоба» (сама
  -- строка и есть этот флаг — см. ensureUserMigrated).
  CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY,
    monthly_income REAL,
    theme TEXT NOT NULL DEFAULT 'light',
    hide_balance INTEGER NOT NULL DEFAULT 0,
    fixed_skips TEXT NOT NULL DEFAULT '[]',
    piggy_enabled INTEGER NOT NULL DEFAULT 0,
    piggy_mode TEXT NOT NULL DEFAULT 'smart',
    piggy_amount REAL NOT NULL DEFAULT 0,
    display_name TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  );

  -- Более старые схемы хранения — не трогаем, они только источник для ленивой
  -- миграции (см. ensureUserMigrated) и резервная копия на случай проблем с переездом.
  CREATE TABLE IF NOT EXISTS states_v2 (
    user_id    TEXT PRIMARY KEY,
    username   TEXT,
    data       TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
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
try { db.exec("ALTER TABLE states ADD COLUMN migrated_to TEXT"); } catch { /* уже есть */ }
// asset_id/goal_id/debt_repay добавлены в transactions уже после первого деплоя нормализованных
// таблиц — CREATE TABLE IF NOT EXISTS не трогает существующую таблицу, поэтому каждую новую
// колонку нужно добавлять отдельной ALTER TABLE (см. инцидент в истории — забыли для asset_id,
// сервис падал на старте; теперь добавляем миграцию в ТОМ ЖЕ коммите, что и саму колонку)
try { db.exec("ALTER TABLE transactions ADD COLUMN asset_id TEXT"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE transactions ADD COLUMN goal_id TEXT"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE transactions ADD COLUMN debt_repay TEXT"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE transactions ADD COLUMN asset_qty REAL"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE transactions ADD COLUMN interest_portion REAL"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE debts ADD COLUMN loan_type TEXT"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE debts ADD COLUMN rate REAL"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE debts ADD COLUMN start_date TEXT"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE debts ADD COLUMN payment_day INTEGER"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE debts ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 0"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE debts ADD COLUMN notify_days_before INTEGER NOT NULL DEFAULT 3"); } catch { /* уже есть */ }

// Лог для Admin (см. admin-internal.js) — своя таблица поверх той же базы.
const adminLog = createAdminLog(db);

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
  // Ссылку на саму базу держим здесь намеренно: после инициализации модуль
  // больше нигде не упоминает переменную `db` напрямую, и V8 вправе выбросить
  // её из контекста — тогда финализатор DatabaseSync закроет базу, и все
  // подготовленные запросы начнут падать с «statement has been finalized».
  // Раз stmt захвачен обработчиками запросов, база через него остаётся достижимой.
  db,

  // v3, нормализованные таблицы
  listTx: db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC"),
  getTx: db.prepare("SELECT * FROM transactions WHERE user_id = ? AND id = ?"),
  insTx: db.prepare("INSERT INTO transactions (id,user_id,type,cat,amount,note,date,fixed_id,refund_for,card_id,card_repay,piggy_id,asset_id,goal_id,debt_repay,asset_qty,interest_portion,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"),
  updTx: db.prepare("UPDATE transactions SET type=?,cat=?,amount=?,note=?,date=?,fixed_id=?,refund_for=?,card_id=?,card_repay=?,piggy_id=?,asset_id=?,goal_id=?,debt_repay=?,asset_qty=?,interest_portion=?,updated_at=? WHERE user_id=? AND id=?"),
  delTx: db.prepare("DELETE FROM transactions WHERE user_id = ? AND id = ?"),
  delAllTx: db.prepare("DELETE FROM transactions WHERE user_id = ?"),

  listGoals: db.prepare("SELECT * FROM goals WHERE user_id = ? ORDER BY created_at ASC"),
  getGoal: db.prepare("SELECT * FROM goals WHERE user_id = ? AND id = ?"),
  insGoal: db.prepare("INSERT INTO goals (id,user_id,name,target,saved,emoji,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"),
  updGoal: db.prepare("UPDATE goals SET name=?,target=?,saved=?,emoji=?,updated_at=? WHERE user_id=? AND id=?"),
  delGoal: db.prepare("DELETE FROM goals WHERE user_id = ? AND id = ?"),
  delAllGoals: db.prepare("DELETE FROM goals WHERE user_id = ?"),

  listDebts: db.prepare("SELECT * FROM debts WHERE user_id = ? ORDER BY created_at ASC"),
  getDebt: db.prepare("SELECT * FROM debts WHERE user_id = ? AND id = ?"),
  insDebt: db.prepare("INSERT INTO debts (id,user_id,kind,name,emoji,card_limit,used,total,remaining,monthly,loan_type,rate,start_date,payment_day,notify_email,notify_days_before,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"),
  updDebt: db.prepare("UPDATE debts SET kind=?,name=?,emoji=?,card_limit=?,used=?,total=?,remaining=?,monthly=?,loan_type=?,rate=?,start_date=?,payment_day=?,notify_email=?,notify_days_before=?,updated_at=? WHERE user_id=? AND id=?"),
  delDebt: db.prepare("DELETE FROM debts WHERE user_id = ? AND id = ?"),
  delAllDebts: db.prepare("DELETE FROM debts WHERE user_id = ?"),

  listFixed: db.prepare("SELECT * FROM fixed_payments WHERE user_id = ? ORDER BY created_at ASC"),
  getFixed: db.prepare("SELECT * FROM fixed_payments WHERE user_id = ? AND id = ?"),
  insFixed: db.prepare("INSERT INTO fixed_payments (id,user_id,name,amount,days,emoji,category,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"),
  updFixed: db.prepare("UPDATE fixed_payments SET name=?,amount=?,days=?,emoji=?,category=?,updated_at=? WHERE user_id=? AND id=?"),
  delFixed: db.prepare("DELETE FROM fixed_payments WHERE user_id = ? AND id = ?"),
  delAllFixed: db.prepare("DELETE FROM fixed_payments WHERE user_id = ?"),

  listAssets: db.prepare("SELECT * FROM assets WHERE user_id = ? ORDER BY created_at ASC"),
  getAsset: db.prepare("SELECT * FROM assets WHERE user_id = ? AND id = ?"),
  insAsset: db.prepare("INSERT INTO assets (id,user_id,name,emoji,amount,ticker,qty,last_price,price_updated,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"),
  updAsset: db.prepare("UPDATE assets SET name=?,emoji=?,amount=?,ticker=?,qty=?,last_price=?,price_updated=?,updated_at=? WHERE user_id=? AND id=?"),
  delAsset: db.prepare("DELETE FROM assets WHERE user_id = ? AND id = ?"),
  delAllAssets: db.prepare("DELETE FROM assets WHERE user_id = ?"),

  getSettings: db.prepare("SELECT * FROM settings WHERE user_id = ?"),
  upsertSettings: db.prepare(`
    INSERT INTO settings (user_id,monthly_income,theme,hide_balance,fixed_skips,piggy_enabled,piggy_mode,piggy_amount,display_name,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      monthly_income=excluded.monthly_income, theme=excluded.theme, hide_balance=excluded.hide_balance,
      fixed_skips=excluded.fixed_skips, piggy_enabled=excluded.piggy_enabled, piggy_mode=excluded.piggy_mode,
      piggy_amount=excluded.piggy_amount, display_name=excluded.display_name, updated_at=excluded.updated_at
  `),

  listAccounts: db.prepare(`
    SELECT s.user_id, s.display_name, s.updated_at,
      (SELECT COUNT(*) FROM transactions WHERE user_id = s.user_id) AS tx_count,
      (SELECT COUNT(*) FROM goals WHERE user_id = s.user_id) AS goals_count,
      (SELECT COUNT(*) FROM debts WHERE user_id = s.user_id) AS debts_count,
      (SELECT COUNT(*) FROM assets WHERE user_id = s.user_id) AS assets_count
    FROM settings s ORDER BY s.updated_at DESC
  `),

  // v2 (переезд с username на user_id) и совсем старая v1 — только на чтение, источники миграции
  getV2: db.prepare("SELECT data, updated_at FROM states_v2 WHERE user_id = ?"),
  legacyState: db.prepare("SELECT data, updated_at FROM states WHERE username = ? AND migrated_to IS NULL"),
  markLegacyMigrated: db.prepare("UPDATE states SET migrated_to = ? WHERE username = ? AND migrated_to IS NULL"),
};

// ---------- валидация (сервер теперь принимает запросы не только от своего фронта) ----------
function toAmount(v) {
  const n = typeof v === "number" ? v : (typeof v === "string" ? parseFloat(v.replace(",", ".")) : NaN);
  if (!isFinite(n) || n < 0) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function toNum(v) {
  const n = typeof v === "number" ? v : (typeof v === "string" ? parseFloat(v.replace(",", ".")) : NaN);
  return isFinite(n) ? n : null;
}
function strOrNull(v) { return typeof v === "string" && v ? v : null; }
function strTrim(v, def) { return typeof v === "string" && v.trim() ? v.trim() : def; }

function validateTx(body) {
  const errors = {};
  const type = body.type === "exp" || body.type === "inc" ? body.type : null;
  if (!type) errors.type = "обязателен, 'exp' или 'inc'";
  const amount = toAmount(body.amount);
  if (amount == null) errors.amount = "число ≥ 0";
  const date = typeof body.date === "string" && !isNaN(Date.parse(body.date)) ? body.date : null;
  if (!date) errors.date = "обязательна, ISO-строка даты";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true, value: {
      type, amount, cat: strTrim(body.cat, "Другое"), note: typeof body.note === "string" ? body.note : "", date,
      fixedId: strOrNull(body.fixedId), refundFor: strOrNull(body.refundFor),
      cardId: strOrNull(body.cardId), cardRepay: strOrNull(body.cardRepay), piggyId: strOrNull(body.piggyId),
      assetId: strOrNull(body.assetId), goalId: strOrNull(body.goalId), debtRepay: strOrNull(body.debtRepay),
      assetQty: (() => { const q = toNum(body.assetQty); return q != null && q > 0 ? q : null; })(),
      interestPortion: (() => { const ip = toNum(body.interestPortion); return ip != null && ip > 0 ? ip : null; })(),
    }
  };
}
function validateGoal(body) {
  const errors = {};
  const target = toAmount(body.target);
  if (target == null || target <= 0) errors.target = "число > 0";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { target, saved: toAmount(body.saved) || 0, name: strTrim(body.name, "Без названия"), emoji: strTrim(body.emoji, "🎯") } };
}
const LOAN_TYPES = ["mortgage", "consumer", "auto", "installment", "other"];
function validateDebt(body) {
  const kind = body.kind === "card" ? "card" : null;
  const value = {
    kind, name: strTrim(body.name, "Без названия"), emoji: strTrim(body.emoji, kind === "card" ? "💳" : "🏦"),
    limit: null, used: null, total: null, remaining: null, monthly: null,
    loanType: null, rate: null, startDate: null, paymentDay: null, notifyEmail: false, notifyDaysBefore: 3,
  };
  if (kind === "card") { value.limit = toAmount(body.limit) || 0; value.used = toAmount(body.used) || 0; }
  else {
    value.total = toAmount(body.total) || 0; value.remaining = toAmount(body.remaining) || 0; value.monthly = toAmount(body.monthly) || 0;
    value.loanType = LOAN_TYPES.includes(body.loanType) ? body.loanType : null;
    const rate = toNum(body.rate); value.rate = rate != null && rate > 0 ? rate : null;
    value.startDate = typeof body.startDate === "string" && !isNaN(Date.parse(body.startDate)) ? body.startDate : null;
    const day = toNum(body.paymentDay); value.paymentDay = day != null && day >= 1 && day <= 31 ? Math.round(day) : null;
    value.notifyEmail = !!body.notifyEmail;
    const notifyDays = toNum(body.notifyDaysBefore); value.notifyDaysBefore = notifyDays != null && notifyDays >= 0 ? Math.round(notifyDays) : 3;
  }
  return { ok: true, value };
}
function validateFixed(body) {
  const errors = {};
  const amount = toAmount(body.amount);
  if (amount == null || amount <= 0) errors.amount = "число > 0";
  if (Object.keys(errors).length) return { ok: false, errors };
  const days = Array.isArray(body.days) ? [...new Set(body.days.map(d => parseInt(d, 10)).filter(d => d >= 1 && d <= 31))].sort((a, b) => a - b) : [];
  return { ok: true, value: { amount, days, name: strTrim(body.name, "Без названия"), emoji: strTrim(body.emoji, "🏠"), category: strOrNull(body.category) } };
}
function validateAsset(body) {
  const ticker = strOrNull(body.ticker);
  const qty = ticker ? toNum(body.qty) : null;
  const lastPrice = ticker ? toNum(body.lastPrice) : null;
  const priceUpdated = ticker && typeof body.priceUpdated === "string" && !isNaN(Date.parse(body.priceUpdated)) ? body.priceUpdated : null;
  const amount = toAmount(body.amount) ?? (ticker && qty && lastPrice ? Math.round(qty * lastPrice * 100) / 100 : 0);
  return { ok: true, value: { name: strTrim(body.name, "Без названия"), emoji: strTrim(body.emoji, "💰"), amount, ticker, qty, lastPrice, priceUpdated } };
}
function validateSettings(body) {
  const piggySrc = body.piggy && typeof body.piggy === "object" ? body.piggy : {};
  const piggyModeNum = toNum(piggySrc.mode);
  return {
    ok: true, value: {
      monthlyIncome: toAmount(body.monthlyIncome),
      theme: body.theme === "dark" ? "dark" : "light",
      hideBalance: !!body.hideBalance,
      fixedSkips: Array.isArray(body.fixedSkips) ? body.fixedSkips.filter(x => typeof x === "string") : [],
      piggy: { enabled: !!piggySrc.enabled, mode: piggySrc.mode === "smart" || !(piggyModeNum > 0) ? "smart" : String(piggyModeNum), amount: toAmount(piggySrc.amount) || 0 },
      displayName: typeof body.displayName === "string" ? body.displayName.trim().slice(0, 60) : "",
    }
  };
}

// ---------- преобразование строк БД <-> формы, которые ждёт клиент ----------
function rowToTx(r) { return { id: r.id, type: r.type, cat: r.cat, amount: r.amount, note: r.note, date: r.date, fixedId: r.fixed_id, refundFor: r.refund_for, cardId: r.card_id, cardRepay: r.card_repay, piggyId: r.piggy_id, assetId: r.asset_id, goalId: r.goal_id, debtRepay: r.debt_repay, assetQty: r.asset_qty, interestPortion: r.interest_portion }; }
function rowToGoal(r) { return { id: r.id, name: r.name, target: r.target, saved: r.saved, emoji: r.emoji }; }
function rowToDebt(r) {
  const base = { id: r.id, name: r.name, emoji: r.emoji };
  if (r.kind === "card") return { ...base, kind: "card", limit: r.card_limit, used: r.used };
  return {
    ...base, total: r.total, remaining: r.remaining, monthly: r.monthly,
    loanType: r.loan_type, rate: r.rate, startDate: r.start_date, paymentDay: r.payment_day,
    notifyEmail: !!r.notify_email, notifyDaysBefore: r.notify_days_before,
  };
}
function rowToFixed(r) { return { id: r.id, name: r.name, amount: r.amount, days: JSON.parse(r.days || "[]"), emoji: r.emoji, category: r.category }; }
function rowToAsset(r) { return { id: r.id, name: r.name, emoji: r.emoji, amount: r.amount, ticker: r.ticker, qty: r.qty, lastPrice: r.last_price, priceUpdated: r.price_updated }; }
function rowToSettings(r) {
  if (!r) return { monthlyIncome: null, theme: "light", hideBalance: false, fixedSkips: [], piggy: { enabled: false, mode: "smart", amount: 0 }, displayName: "" };
  return { monthlyIncome: r.monthly_income, theme: r.theme, hideBalance: !!r.hide_balance, fixedSkips: JSON.parse(r.fixed_skips || "[]"), piggy: { enabled: !!r.piggy_enabled, mode: r.piggy_mode, amount: r.piggy_amount }, displayName: r.display_name };
}

// ---------- миграция блоба -> нормализованные таблицы, лениво при первом обращении ----------
/**
 * Данные пользователя раньше лежали одним JSON-блобом под user_id (states_v2),
 * а до этого — под логином (states). Обе схемы остались как источники для
 * одноразового переноса: при первом обращении конкретного user_id к любому
 * ресурсу разбираем блоб (если он есть) на нормализованные таблицы. Наличие
 * строки в settings — и есть отметка «уже перенесён», отдельного флага не заводим.
 */
function ensureUserMigrated(user) {
  if (stmt.getSettings.get(user.id)) return;

  let blob = null, updatedAt = 0;
  const v2 = stmt.getV2.get(user.id);
  if (v2 && v2.data) { blob = JSON.parse(v2.data); updatedAt = v2.updated_at; }
  else if (user.username) {
    const legacy = stmt.legacyState.get(user.username);
    if (legacy && legacy.data) {
      blob = JSON.parse(legacy.data); updatedAt = legacy.updated_at;
      stmt.markLegacyMigrated.run(user.id, user.username);
      console.log(`«${user.username}»: данные перенесены со старой таблицы states на user_id ${user.id}`);
    }
  }

  const now = Date.now();
  if (blob) {
    decomposeInto(user.id, blob, now);
    console.log(`«${user.username || user.id}»: блоб разобран на нормализованные таблицы (был обновлён ${new Date(updatedAt).toISOString()})`);
  } else {
    // с нуля: просто создаём пустую строку настроек — это и есть отметка «мигрирован»
    stmt.upsertSettings.run(user.id, null, "light", 0, "[]", 0, "smart", 0, "", now);
  }
}

/** Полная замена данных пользователя данными из блоба (формат — как в старом /api/state). Атомарно. */
function decomposeInto(userId, data, now) {
  now = now || Date.now();
  data = data && typeof data === "object" ? data : {};
  db.exec("BEGIN");
  try {
    stmt.delAllTx.run(userId); stmt.delAllGoals.run(userId); stmt.delAllDebts.run(userId);
    stmt.delAllFixed.run(userId); stmt.delAllAssets.run(userId);

    (Array.isArray(data.tx) ? data.tx : []).forEach(t => {
      if (!t || !t.id) return;
      const assetQty = (() => { const q = toNum(t.assetQty); return q != null && q > 0 ? q : null; })();
      const interestPortion = (() => { const ip = toNum(t.interestPortion); return ip != null && ip > 0 ? ip : null; })();
      stmt.insTx.run(String(t.id), userId, t.type === "inc" ? "inc" : "exp", strTrim(t.cat, "Другое"), toAmount(t.amount) || 0, typeof t.note === "string" ? t.note : "", typeof t.date === "string" ? t.date : new Date().toISOString(), strOrNull(t.fixedId), strOrNull(t.refundFor), strOrNull(t.cardId), strOrNull(t.cardRepay), strOrNull(t.piggyId), strOrNull(t.assetId), strOrNull(t.goalId), strOrNull(t.debtRepay), assetQty, interestPortion, now, now);
    });
    (Array.isArray(data.goals) ? data.goals : []).forEach(g => {
      if (!g || !g.id) return;
      stmt.insGoal.run(String(g.id), userId, strTrim(g.name, "Без названия"), toAmount(g.target) || 0, toAmount(g.saved) || 0, strTrim(g.emoji, "🎯"), now, now);
    });
    (Array.isArray(data.debts) ? data.debts : []).forEach(d => {
      if (!d || !d.id) return;
      const isCard = d.kind === "card";
      const rate = isCard ? null : (() => { const r = toNum(d.rate); return r != null && r > 0 ? r : null; })();
      const payDay = isCard ? null : (() => { const p = toNum(d.paymentDay); return p != null && p >= 1 && p <= 31 ? Math.round(p) : null; })();
      const notifyDays = (() => { const n = toNum(d.notifyDaysBefore); return n != null && n >= 0 ? Math.round(n) : 3; })();
      stmt.insDebt.run(
        String(d.id), userId, isCard ? "card" : null, strTrim(d.name, "Без названия"), strTrim(d.emoji, isCard ? "💳" : "🏦"),
        toAmount(d.limit), toAmount(d.used), toAmount(d.total), toAmount(d.remaining), toAmount(d.monthly),
        isCard ? null : (LOAN_TYPES.includes(d.loanType) ? d.loanType : null), rate,
        isCard ? null : (typeof d.startDate === "string" && !isNaN(Date.parse(d.startDate)) ? d.startDate : null),
        payDay, isCard ? 0 : (d.notifyEmail ? 1 : 0), notifyDays, now, now
      );
    });
    (Array.isArray(data.fixed) ? data.fixed : []).forEach(f => {
      if (!f || !f.id) return;
      const days = Array.isArray(f.days) ? f.days.filter(d => Number.isInteger(d) && d >= 1 && d <= 31) : [];
      stmt.insFixed.run(String(f.id), userId, strTrim(f.name, "Без названия"), toAmount(f.amount) || 0, JSON.stringify(days), strTrim(f.emoji, "🏠"), strOrNull(f.category), now, now);
    });
    (Array.isArray(data.assets) ? data.assets : []).forEach(a => {
      if (!a || !a.id) return;
      stmt.insAsset.run(String(a.id), userId, strTrim(a.name, "Без названия"), strTrim(a.emoji, "💰"), toAmount(a.amount) || 0, strOrNull(a.ticker), toNum(a.qty), toNum(a.lastPrice), strOrNull(a.priceUpdated), now, now);
    });
    const piggy = data.piggy && typeof data.piggy === "object" ? data.piggy : {};
    stmt.upsertSettings.run(userId, toAmount(data.monthlyIncome), data.theme === "dark" ? "dark" : "light", data.hideBalance ? 1 : 0, JSON.stringify(Array.isArray(data.fixedSkips) ? data.fixedSkips : []), piggy.enabled ? 1 : 0, piggy.mode === "smart" ? "smart" : (toNum(piggy.mode) > 0 ? String(toNum(piggy.mode)) : "smart"), toAmount(piggy.amount) || 0, typeof data.displayName === "string" ? data.displayName.slice(0, 60) : "", now);

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return now;
}

/** Весь блоб пользователя, собранный из нормализованных таблиц — в форме, которую ждёт фронт. */
function composeState(userId) {
  const s = stmt.getSettings.get(userId);
  return {
    tx: stmt.listTx.all(userId).map(rowToTx),
    goals: stmt.listGoals.all(userId).map(rowToGoal),
    debts: stmt.listDebts.all(userId).map(rowToDebt),
    fixed: stmt.listFixed.all(userId).map(rowToFixed),
    assets: stmt.listAssets.all(userId).map(rowToAsset),
    ...rowToSettings(s),
  };
}

/**
 * Сводка по счёту без выгрузки всех сущностей — баланс/доходы/расходы/net worth.
 * Формулы намеренно зеркалят cashTxAmount()/render() из assets/app.js: покупка с
 * кредитки (cardId) деньги со счёта не уводит, а погашение (cardRepay/debtRepay),
 * пополнение копилки (piggyId), перевод в актив (assetId) и пополнение/снятие цели
 * (goalId, может быть и exp, и inc) — обычные движения денег по счёту, но не по
 * аналитике/категориям (это переводы, а не траты/доходы). Если эти правила
 * поменяются на фронте — поправить и здесь.
 */
function computeSummary(userId) {
  const tx = stmt.listTx.all(userId);
  let balance = 0, incomeTotal = 0, expenseTotal = 0;
  for (const t of tx) {
    if (t.type === "inc") { if (!t.goal_id) incomeTotal += t.amount; if (!t.card_id) balance += t.amount; }
    else { if (!t.card_repay && !t.piggy_id && !t.asset_id && !t.goal_id && !t.debt_repay) expenseTotal += t.amount; if (!t.card_id) balance -= t.amount; }
  }
  const assetsTotal = stmt.listAssets.all(userId).reduce((s, a) => s + (a.amount || 0), 0);
  const debtsOwed = stmt.listDebts.all(userId).reduce((s, d) => s + (d.kind === "card" ? (d.used || 0) : (d.remaining || 0)), 0);
  const settings = stmt.getSettings.get(userId);
  const piggyAmount = settings ? settings.piggy_amount : 0;
  const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
  return {
    balance: round(balance), incomeTotal: round(incomeTotal), expenseTotal: round(expenseTotal),
    assetsTotal: round(assetsTotal), debtsOwed: round(debtsOwed), piggyAmount: round(piggyAmount),
    netWorth: round(balance + assetsTotal + piggyAmount - debtsOwed),
  };
}

// ---------- CLI ----------
const [, , cmd] = process.argv;
if (cmd === "states") {
  const rows = stmt.listAccounts.all();
  if (!rows.length) console.log("(пусто)");
  for (const r of rows) {
    const label = r.display_name || r.user_id;
    console.log(`${label.padEnd(24)}  ${r.user_id}  tx:${r.tx_count} goals:${r.goals_count} debts:${r.debts_count} assets:${r.assets_count}  ${new Date(r.updated_at).toISOString().slice(0, 19).replace("T", " ")}`);
  }
  process.exit(0);
}
if (cmd) {
  console.error(`Неизвестная команда: ${cmd}\n\nДоступно: states\nАккаунтами заведует auth-сервис — см. там adduser/passwd/users.`);
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
  clockSkew: process.env.AUTH_CLOCK_SKEW == null ? undefined : parseInt(process.env.AUTH_CLOCK_SKEW, 10),
});
auth.warmup();

async function requireUser(req) {
  const user = await auth.userFromRequest(req);
  if (!user) return null;
  ensureUserMigrated(user);
  return user;
}

// ---------- утилиты HTTP ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function errJson(res, code, errCode, message, fields) {
  const error = { code: errCode, message };
  if (fields) error.fields = fields;
  return json(res, code, { error });
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else data += c; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
async function readJsonBody(req) {
  try { return { ok: true, value: JSON.parse(await readBody(req) || "{}") }; }
  catch { return { ok: false }; }
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
  ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8"
};
const ASSETS_DIR = path.join(__dirname, "assets");
// calculator.html — публичная, без токена (index.html после логина сама уводит на SSO,
// а сюда специально должны попадать и поисковые боты, см. robots.txt/sitemap.xml ниже).
const ROOT_STATIC_PATHS = ["/index.html", "/calculator.html", "/robots.txt", "/sitemap.xml"];
// Отдаём ТОЛЬКО эти файлы и всё из assets/. store.db, server.js и т.п. недоступны из вне.
function serveStatic(res, pathname) {
  if (!ROOT_STATIC_PATHS.includes(pathname) && !pathname.startsWith("/assets/")) return false;
  const file = path.join(__dirname, path.normalize(pathname).replace(/^([\\/])+/, ""));
  const allowed = file === APP_HTML || file === CALC_HTML || file === ROBOTS_TXT || file === SITEMAP_XML
    || file === ASSETS_DIR || file.startsWith(ASSETS_DIR + path.sep);
  if (!allowed) return false;
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

// ---------- обобщённый CRUD-роут для сущностей ресурсов ----------
/**
 * Все пять ресурсов (transactions/goals/debts/fixed-payments/assets) устроены
 * одинаково снаружи: GET-список, POST-создать, GET/PUT/DELETE по :id. Общая
 * HTTP-механика вынесена сюда один раз; что у каждого ресурса своё — таблично
 * в RESOURCES ниже (список/чтение/запись/валидация/преобразование строки).
 */
async function handleResourceRoute(req, res, resource, id, user) {
  if (id == null) {
    if (req.method === "GET") return json(res, 200, { items: resource.list(user.id).map(resource.toObj) });
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ok) return errJson(res, 400, "invalid_json", "Тело запроса — не валидный JSON");
      const v = resource.validate(body.value);
      if (!v.ok) return errJson(res, 422, "validation_error", "Проверьте поля запроса", v.errors);
      const rawId = strOrNull(body.value.id);
      const newId = rawId && !rawId.includes("/") ? rawId : crypto.randomUUID(); // с "/" ресурс стал бы недостижим по своему же URL
      const row = resource.create(user.id, newId, v.value);
      return json(res, 201, resource.toObj(row));
    }
    return errJson(res, 405, "method_not_allowed", "Метод не поддерживается для этого пути");
  }
  if (req.method === "GET") {
    const row = resource.get(user.id, id);
    return row ? json(res, 200, resource.toObj(row)) : errJson(res, 404, "not_found", "Не найдено");
  }
  if (req.method === "PUT") {
    const body = await readJsonBody(req);
    if (!body.ok) return errJson(res, 400, "invalid_json", "Тело запроса — не валидный JSON");
    const v = resource.validate(body.value);
    if (!v.ok) return errJson(res, 422, "validation_error", "Проверьте поля запроса", v.errors);
    const row = resource.update(user.id, id, v.value);
    return row ? json(res, 200, resource.toObj(row)) : errJson(res, 404, "not_found", "Не найдено");
  }
  if (req.method === "DELETE") {
    const removed = resource.remove(user.id, id);
    return removed ? json(res, 200, { ok: true }) : errJson(res, 404, "not_found", "Не найдено");
  }
  return errJson(res, 405, "method_not_allowed", "Метод не поддерживается для этого пути");
}

const now = () => Date.now();
const RESOURCES = {
  transactions: {
    list: (uid) => stmt.listTx.all(uid), get: (uid, id) => stmt.getTx.get(uid, id), toObj: rowToTx, validate: validateTx,
    create(uid, id, v) { stmt.insTx.run(id, uid, v.type, v.cat, v.amount, v.note, v.date, v.fixedId, v.refundFor, v.cardId, v.cardRepay, v.piggyId, v.assetId, v.goalId, v.debtRepay, v.assetQty, v.interestPortion, now(), now()); return stmt.getTx.get(uid, id); },
    update(uid, id, v) { if (!stmt.getTx.get(uid, id)) return null; stmt.updTx.run(v.type, v.cat, v.amount, v.note, v.date, v.fixedId, v.refundFor, v.cardId, v.cardRepay, v.piggyId, v.assetId, v.goalId, v.debtRepay, v.assetQty, v.interestPortion, now(), uid, id); return stmt.getTx.get(uid, id); },
    remove(uid, id) { const existed = !!stmt.getTx.get(uid, id); if (existed) stmt.delTx.run(uid, id); return existed; },
  },
  goals: {
    list: (uid) => stmt.listGoals.all(uid), get: (uid, id) => stmt.getGoal.get(uid, id), toObj: rowToGoal, validate: validateGoal,
    create(uid, id, v) { stmt.insGoal.run(id, uid, v.name, v.target, v.saved, v.emoji, now(), now()); return stmt.getGoal.get(uid, id); },
    update(uid, id, v) { if (!stmt.getGoal.get(uid, id)) return null; stmt.updGoal.run(v.name, v.target, v.saved, v.emoji, now(), uid, id); return stmt.getGoal.get(uid, id); },
    remove(uid, id) { const existed = !!stmt.getGoal.get(uid, id); if (existed) stmt.delGoal.run(uid, id); return existed; },
  },
  debts: {
    list: (uid) => stmt.listDebts.all(uid), get: (uid, id) => stmt.getDebt.get(uid, id), toObj: rowToDebt, validate: validateDebt,
    create(uid, id, v) { stmt.insDebt.run(id, uid, v.kind, v.name, v.emoji, v.limit, v.used, v.total, v.remaining, v.monthly, v.loanType, v.rate, v.startDate, v.paymentDay, v.notifyEmail ? 1 : 0, v.notifyDaysBefore, now(), now()); return stmt.getDebt.get(uid, id); },
    update(uid, id, v) { if (!stmt.getDebt.get(uid, id)) return null; stmt.updDebt.run(v.kind, v.name, v.emoji, v.limit, v.used, v.total, v.remaining, v.monthly, v.loanType, v.rate, v.startDate, v.paymentDay, v.notifyEmail ? 1 : 0, v.notifyDaysBefore, now(), uid, id); return stmt.getDebt.get(uid, id); },
    remove(uid, id) { const existed = !!stmt.getDebt.get(uid, id); if (existed) stmt.delDebt.run(uid, id); return existed; },
  },
  "fixed-payments": {
    list: (uid) => stmt.listFixed.all(uid), get: (uid, id) => stmt.getFixed.get(uid, id), toObj: rowToFixed, validate: validateFixed,
    create(uid, id, v) { stmt.insFixed.run(id, uid, v.name, v.amount, JSON.stringify(v.days), v.emoji, v.category, now(), now()); return stmt.getFixed.get(uid, id); },
    update(uid, id, v) { if (!stmt.getFixed.get(uid, id)) return null; stmt.updFixed.run(v.name, v.amount, JSON.stringify(v.days), v.emoji, v.category, now(), uid, id); return stmt.getFixed.get(uid, id); },
    remove(uid, id) { const existed = !!stmt.getFixed.get(uid, id); if (existed) stmt.delFixed.run(uid, id); return existed; },
  },
  assets: {
    list: (uid) => stmt.listAssets.all(uid), get: (uid, id) => stmt.getAsset.get(uid, id), toObj: rowToAsset, validate: validateAsset,
    create(uid, id, v) { stmt.insAsset.run(id, uid, v.name, v.emoji, v.amount, v.ticker, v.qty, v.lastPrice, v.priceUpdated, now(), now()); return stmt.getAsset.get(uid, id); },
    update(uid, id, v) { if (!stmt.getAsset.get(uid, id)) return null; stmt.updAsset.run(v.name, v.emoji, v.amount, v.ticker, v.qty, v.lastPrice, v.priceUpdated, now(), uid, id); return stmt.getAsset.get(uid, id); },
    remove(uid, id) { const existed = !!stmt.getAsset.get(uid, id); if (existed) stmt.delAsset.run(uid, id); return existed; },
  },
};

// ---------- сервер ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {

  // CORS: нужен, только если фронтенд отдаётся отдельно от этого сервера.
  // Без ALLOWED_ORIGIN заголовки не шлём (обычный случай — всё на одном домене).
  if (ALLOWED_ORIGIN && p.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }

  // Куда фронту идти за входом. Отдаём с сервера, чтобы адрес auth-сервиса
  // не был зашит в статику и менялся одной переменной окружения.
  if (p === "/api/v1/config") return json(res, 200, { authBase: AUTH_BASE, clientId: AUTH_CLIENT_ID });
  if (p === "/api/v1/health") return json(res, 200, { ok: true });

  // Для Admin: server-to-server по общему ключу (см. admin-internal.js), не SSO.
  if (p === "/internal/stats" && req.method === "GET") {
    if (!checkAdminKey(req)) return errJson(res, 403, "forbidden", "Доступ запрещён");
    const since7d = now() - 7 * 24 * 60 * 60 * 1000;
    return json(res, 200, {
      ok: true,
      users: db.prepare("SELECT COUNT(*) AS n FROM settings").get().n,
      transactions: db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n,
      goals: db.prepare("SELECT COUNT(*) AS n FROM goals").get().n,
      debts: db.prepare("SELECT COUNT(*) AS n FROM debts").get().n,
      assets: db.prepare("SELECT COUNT(*) AS n FROM assets").get().n,
      // Активность, а не просто накопленный объём: сколько записей и разных
      // людей реально пользовались сервисом за последнюю неделю.
      transactions7d: db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE created_at > ?").get(since7d).n,
      activeUsers7d: db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM transactions WHERE created_at > ?").get(since7d).n,
    });
  }
  if (p === "/internal/logs" && req.method === "GET") {
    if (!checkAdminKey(req)) return errJson(res, 403, "forbidden", "Доступ запрещён");
    const since = url.searchParams.get("since");
    const limit = url.searchParams.get("limit");
    return json(res, 200, {
      logs: adminLog.recent({ since: since ? Number(since) : undefined, limit: limit ? Number(limit) : undefined }),
    });
  }

  // Гранулярные REST-ресурсы: /api/v1/<resource>[/<id>]
  for (const name of Object.keys(RESOURCES)) {
    const prefix = "/api/v1/" + name;
    if (p === prefix || p.startsWith(prefix + "/")) {
      const rest = p.slice(prefix.length + 1); // без ведущего слэша; "" если пути не было
      const id = rest ? decodeURIComponent(rest) : null;
      if (rest.includes("/")) break; // /api/v1/transactions/x/y — не наш путь, отдать 404 ниже
      const user = await requireUser(req);
      if (!user) return errJson(res, 401, "unauthorized", "Нужен действующий access-токен");
      return handleResourceRoute(req, res, RESOURCES[name], id, user);
    }
  }

  if (p === "/api/v1/settings") {
    const user = await requireUser(req);
    if (!user) return errJson(res, 401, "unauthorized", "Нужен действующий access-токен");
    if (req.method === "GET") return json(res, 200, rowToSettings(stmt.getSettings.get(user.id)));
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      if (!body.ok) return errJson(res, 400, "invalid_json", "Тело запроса — не валидный JSON");
      const v = validateSettings(body.value).value;
      const updatedAt = now();
      stmt.upsertSettings.run(user.id, v.monthlyIncome, v.theme, v.hideBalance ? 1 : 0, JSON.stringify(v.fixedSkips), v.piggy.enabled ? 1 : 0, v.piggy.mode, v.piggy.amount, v.displayName, updatedAt);
      return json(res, 200, rowToSettings(stmt.getSettings.get(user.id)));
    }
    return errJson(res, 405, "method_not_allowed", "Метод не поддерживается для этого пути");
  }

  if (p === "/api/v1/summary") {
    const user = await requireUser(req);
    if (!user) return errJson(res, 401, "unauthorized", "Нужен действующий access-токен");
    if (req.method !== "GET") return errJson(res, 405, "method_not_allowed", "Метод не поддерживается для этого пути");
    return json(res, 200, computeSummary(user.id));
  }

  // Весь блоб разом — так фронт «Финансов» продолжает синхронизироваться одним запросом,
  // не переписываясь на гранулярные ресурсы. Под капотом — те же нормализованные таблицы.
  if (p === "/api/v1/state") {
    const user = await requireUser(req);
    if (!user) return errJson(res, 401, "unauthorized", "Нужен действующий access-токен");
    if (req.method === "GET") {
      const s = stmt.getSettings.get(user.id);
      return json(res, 200, { data: composeState(user.id), updatedAt: s ? s.updated_at : 0 });
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      if (!body.ok || typeof body.value.data !== "object" || body.value.data === null) return errJson(res, 400, "invalid_body", "Ожидается {data: {...}}");
      const updatedAt = decomposeInto(user.id, body.value.data);
      return json(res, 200, { ok: true, updatedAt });
    }
    return errJson(res, 405, "method_not_allowed", "Метод не поддерживается для этого пути");
  }

  // статика (css/js) и приложение (SPA-стиль fallback)
  if (req.method === "GET") {
    if (p !== "/" && serveStatic(res, p)) return;
    return serveApp(res);
  }
  res.writeHead(404); res.end();
  } catch (e) {
    console.error("Необработанная ошибка:", e);
    adminLog.error("Необработанная ошибка", { path: p, method: req.method, message: e.message });
    if (!res.headersSent) return errJson(res, 500, "server_error", "Внутренняя ошибка сервера");
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Мои финансы: http://${HOST}:${PORT}  (данные: ${DB_PATH})`);
  console.log(`Авторизация: ${AUTH_ISSUER} (клиент «${AUTH_CLIENT_ID}»)`);
});
