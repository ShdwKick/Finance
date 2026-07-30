# Подключение сервиса к общему аккаунту BurningHouse

«Мои финансы» больше не держат своих пользователей: аккаунты, пароли и вход живут в
отдельном сервисе `auth.burninghouse.ru` (репозиторий `BurningHouse/Auth`), общем для всех
проектов. Этот файл — рабочий рецепт: сначала как всё устроено здесь, потом как
подключить следующий проект, потом как прошёл переезд.

Развёртывание самого auth-сервиса — в его `README-deploy.md`.

---

## Как это работает

Упрощённый OAuth2 authorization code + PKCE:

```
Finance: кнопка «Войти»
   → auth.burninghouse.ru/authorize?client_id=finance&code_challenge=…
      • есть кука сессии на auth-домене → сразу редирект обратно (пароль не спрашивают)
      • нет → форма входа
   → возврат: money.burninghouse.ru/?code=<одноразовый>&state=…
   → Finance меняет код на токены: POST auth/oauth/token
      • access-JWT — 15 минут, подпись EdDSA
      • refresh — 60 дней, непрозрачный, отзываемый
   → дальше Finance проверяет access-токен САМ, по ключам из /.well-known/jwks.json
```

Ключевое следствие: **на каждый запрос к `/api/state` в auth никто не ходит**. Подпись
проверяется локально, поэтому auth не становится ни узким местом, ни единой точкой отказа —
если он ляжет, работающие сессии продолжат работать. Плата за это — отзыв доступа
срабатывает не мгновенно, а на следующем обновлении токена (не дольше 15 минут).

Пароли этот сервис не видит вообще: ни в каком виде, ни на мгновение.

---

## Что понадобится новому сервису

### 1. Зарегистрировать сервис в auth

```bash
docker compose exec auth node server.js client-add notes "Заметки" https://notes.burninghouse.ru/
```

`redirect_uri` сверяется побайтово, включая слэш на конце.

### 2. Скопировать две библиотеки

Обе без зависимостей, лежат в репозитории Auth в каталоге `client/`:

| Откуда | Куда | Зачем |
|---|---|---|
| `client/auth-client.js` | рядом с `server.js` | проверка токена на бэкенде |
| `client/auth-client-browser.js` | в `assets/` (здесь — как `assets/auth-client.js`) | вход, обновление токена и `fetch` на фронте |

Копия, а не пакет — ровно по той же причине, по которой во всех этих проектах нет
`node_modules`: одна зависимость тянет за собой обновления, аудит и `npm install` в
образе. Файлы маленькие; если поменяются — просто скопировать заново.

### 3. Бэкенд: проверять токен

```js
const auth = require("./auth-client")({
  issuer:   process.env.AUTH_ISSUER,      // https://auth.burninghouse.ru
  audience: process.env.AUTH_CLIENT_ID,   // notes
});
auth.warmup();   // подтянуть ключи заранее, чтобы первый запрос не ждал сеть

// в обработчике:
const user = await auth.userFromRequest(req);   // { id, username, email, sid } | null
if (!user) return json(res, 401, { error: "unauthorized" });
// user.id — стабильный UUID, именно его и надо класть в свои таблицы
```

Живой пример — `/api/state` в [server.js](server.js).

Ещё сервису стоит отдавать фронту адрес auth (чтобы тот не был зашит в статику):

```js
if (p === "/api/config") return json(res, 200, { authBase: AUTH_BASE, clientId: AUTH_CLIENT_ID });
```

### 4. Фронт: вход и запросы

```html
<script src="assets/auth-client.js"></script>
```

```js
const cfg = await (await fetch("/api/config")).json();
const auth = createAuthClient({
  authBase: cfg.authBase,
  clientId: cfg.clientId,
  redirectUri: location.origin + location.pathname,
  storagePrefix: "notes",
});

await auth.handleRedirect();          // вернулись с ?code=… → обменять на токены
if (!auth.isAuthenticated()) auth.login();   // иначе увести на страницу входа

const res = await auth.fetch("/api/data");   // токен подставится сам
// протухший access обновится молча и запрос повторится; если обновить нечем —
// вылетит AuthRequiredError, это и есть «пора логиниться заново»
```

Живой пример — `initAuth` / `pushRemote` / `pullRemote` в [assets/core.js](assets/core.js).

Смену пароля, почту и список устройств делать у себя не нужно: всё это на
`auth.burninghouse.ru/` — ведите туда ссылкой (`auth.accountUrl()`).

### 5. Окружение

```yaml
environment:
  AUTH_ISSUER: https://auth.burninghouse.ru   # обязателен; сверяется побайтово
  AUTH_CLIENT_ID: notes
```

---

## Как прошёл переезд «Финансов»

Что осталось от прежней схемы и что с этим стало:

**Пароли.** Хранились как scrypt-хэш, причём соль передавалась в `scryptSync`
*строкой* (32 ASCII-символа hex-записи), а не 16 байтами. Чтобы никого не заставлять
сбрасывать пароль, auth считает такие хэши точно так же — они помечены
`pwd_algo='scrypt-legacy'`. При первом успешном входе хэш прозрачно пересчитывается в
`scrypt-v1` (соль байтами, N=2^15), так что legacy-ветка со временем вымрет сама.

Команда переноса (подробности в `README-deploy.md` репозитория Auth):

```bash
docker run --rm -v auth-data:/app/data -v moi-finansy_finance-data:/finance:ro \
  shadowkick/auth:latest node server.js import-finance /finance/store.db
```

**Данные.** Были в `states`, ключ — логин. Теперь в `states_v2`, ключ — `user_id`.
Переезд ленивый: логин есть в токене (`preferred_username`), поэтому при первом
обращении пользователя строка переносится сама. Никаких маппингов руками и без простоя.

Старые таблицы `users` и `states` **намеренно оставлены нетронутыми** как резервная
копия; перенесённые строки лишь помечаются в `states.migrated_to`. Убрать их можно
отдельным шагом, когда станет очевидно, что всё работает:

```bash
docker exec finance node server.js states   # покажет, кто переехал, а кто ещё нет
```

**Токены.** Раньше жили в `Map()` в памяти процесса — любой редеплой разлогинивал всех.
Теперь и refresh-токены, и браузерные сессии лежат в SQLite auth-сервиса: рестарт
контейнера пользователи не замечают.

**Что удалено из «Финансов»:** `/api/register`, `/api/login`, `/api/account/password`,
таблица `users`, CLI-команды `adduser`/`passwd`/`users`, форма входа с полями логина и
пароля. Остался единственный защищённый ресурс `/api/state` и CLI `states`.

---

## Что стоит сделать позже

- **Восстановление пароля.** Поле `email` в auth уже есть и заполняется, но писем сервис
  пока не шлёт — нужен SMTP. Пока сброс делается вручную:
  `docker compose exec auth node server.js passwd <логин> <новый пароль>`.
- **Подтверждение почты** — поле `email_verified` заведено и всегда `0`.
- **Уборка** таблиц `users`/`states` в базе «Финансов», когда переезд отстоится.
