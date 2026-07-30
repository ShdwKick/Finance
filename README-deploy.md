# Развёртывание «Мои финансы» на своём сервере

Это личный трекер финансов — статическая страница (`index.html` + `assets/`) плюс
маленький сервер синхронизации (`server.js`, чистый Node.js, без единой npm-зависимости
— даже хранилище встроенное, SQLite через `node:sqlite`). Один сервер отдаёт и то, и
другое с одного домена: открываете `https://ваш-домен` — видите приложение, оно само
стучится на `/api/...` за данными.

Деплой можно свести к одному вопросу: **найти на сервере домен и порт, которые никому
не мешают, и настроить на них HTTPS.** Всё остальное — детали. Ниже — как это сделать
через Docker (самый простой путь) и вариант без Docker для тех, кому он не нужен.

## Ваши значения для этого деплоя

Инструкции ниже написаны с плейсхолдерами (`<домен>`, `<порт>` и т.д.), чтобы годились
для любого сервера. Вот что подставлено на реальном сервере, где приложение сейчас
живёт — для справки и как пример того, как это выглядит в жизни:

| Плейсхолдер | Значение здесь | Почему |
|---|---|---|
| `<домен>` | `money.burninghouse.ru` | Отдельный от `burning-house.online` (тот был для GitHub Pages, которую больше не используем) |
| `<порт>` | `443` | Стандартный HTTPS-порт — не нужно указывать в адресе. Изначально был занят xray (VLESS), поэтому приложение временно жило на 9443 (см. «Проверьте порты» ниже); после того как xray-инбаунд на 443 убрали, переехали на него |
| `<docker-образ>` | `shadowkick/finance:latest` | Публичный образ на Docker Hub |
| репозиторий | `github.com/ShdwKick/Finance` | — |

Регистрация на этом сервере открыта всем (без кода-приглашения) — так решили сознательно.

---

## Путь 1: Docker (рекомендуется)

### Шаг 1. Соберите образ и опубликуйте его в registry

Один раз, с рабочей машины, где лежит код:

```bash
docker build -t <docker-hub-логин>/finance:latest .
docker login -u <docker-hub-логин>   # логин/пароль вводите сами, не через скрипт
docker push <docker-hub-логин>/finance:latest
```

Если репозиторий на Docker Hub публичный (по умолчанию так) — на сервере логиниться
не придётся, просто `docker pull`.

### Шаг 2. Проверьте порты на сервере

Прежде чем занимать что-либо портом наружу — посмотрите, что уже слушает сервер:

```bash
sudo ss -tulpn
```

Если на сервере уже есть VPN (Hysteria2, 3x-ui/xray, WireGuard и т.п.) или другие
сервисы — почти наверняка что-то уже сидит на 443 (VPN-протоколы часто маскируются
под HTTPS специально, чтобы не выделяться). Правило простое: **приложению не обязательно
жить на 443**, любой свободный порт подойдёт — 8443, 9443, что угодно. Найдите в выводе
`ss` порт, которого там нет, и используйте его.

Так, например, выглядела реальная проверка на одном сервере — оказалось, что 443/tcp
занят xray, 8443 (тот порт, который сначала казался очевидным запасным вариантом)
занят Hysteria2 по UDP, а 9443 свободен:

```
tcp   LISTEN  *:443    xray-linux-amd64     ← занято, не трогаем
udp   UNCONN  *:8443   hysteria             ← тоже занято, хоть и другой протокол
                                               (порт 9443 в выводе не встретился — свободен)
```

Отсюда и взялся `<порт> = 9443` в примере выше. Ваш сервер — ваш собственный вывод
`ss`, порт может оказаться другим. Порт 80 обычно тоже стоит оставить свободным —
`certbot` использует его на секунду для подтверждения домена.

**Если позже освободите 443** (например, уберёте инбаунд VPN, который его занимал) —
переносить приложение обратно на стандартный порт просто: в конфиге nginx поменять
`listen <старый порт> ssl;` (и IPv6-строку) на `listen 443 ssl;`, `sudo nginx -t &&
sudo systemctl reload nginx`, открыть 443 в firewall (`sudo ufw allow 443/tcp`) и, если
хотите, закрыть старый порт. Сертификат перевыпускать не нужно — он не привязан к порту.
После этого адрес сайта не требует указания порта: `https://<домен>` вместо
`https://<домен>:<старый порт>`.

### Шаг 3. Установите Docker (если ещё не установлен)

```bash
curl -fsSL https://get.docker.com | sudo sh
```

### Шаг 4. Скачайте и запустите контейнер

```bash
git clone https://github.com/ShdwKick/Finance.git ~/finance
cd ~/finance
cp docker-compose.prod.yml docker-compose.yml
# откройте docker-compose.yml и поправьте image: на свой <docker-hub-логин>/finance:latest

sudo docker compose pull
sudo docker compose up -d
sudo docker compose logs -f finance   # Ctrl+C выходит из просмотра, контейнер продолжает работать
curl -s http://127.0.0.1:8787/api/health   # ожидаем {"ok":true}
```

Контейнер слушает только `127.0.0.1:8787` — снаружи не виден напрямую, наружу его
выставит nginx на следующем шаге.

### Шаг 5. DNS

У регистратора домена добавьте **A-запись**: поддомен → IP сервера (тот же IP, что и у
остальных сервисов на сервере — это нормально, они различаются портами, не IP).
Подождите, пока запись разойдётся: `ping <домен>`.

### Шаг 6. Сертификат и nginx на выбранном порту

```bash
sudo apt install -y nginx certbot
sudo certbot certonly --standalone -d <домен>
# на секунду займёт порт 80 для проверки домена, затем освободит
```

Конфиг nginx (замените `<домен>` и `<порт>` на свои):

```nginx
server {
    listen <порт> ssl;
    listen [::]:<порт> ssl;
    server_name <домен>;

    ssl_certificate     /etc/letsencrypt/live/<домен>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<домен>/privkey.pem;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
```

Готовый файл под конкретно этот деплой (порт 443, домен money.burninghouse.ru) лежит
в `deploy/nginx-finance-443.conf` — можно взять как есть или как образец для своих
значений.

```bash
sudo cp deploy/nginx-finance-443.conf /etc/nginx/sites-available/finance   # или свой файл с шаблона выше
sudo ln -s /etc/nginx/sites-available/finance /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow <порт>/tcp   # если включён firewall
```

Готово: `https://<домен>:<порт>` должен открыть страницу входа (порт `:443` — стандартный,
можно не писать в адресе: просто `https://<домен>`).

### Шаг 7. Первый пользователь

Аккаунтами этот сервис больше не заведует — они живут в общем auth-сервисе
(`auth.burninghouse.ru`), один на все проекты BurningHouse. Поэтому:

1. Auth-сервис должен быть развёрнут и знать про этот сервис как про клиента:
   `docker compose exec auth node server.js client-add finance "Мои финансы" https://money.burninghouse.ru/`
2. В `docker-compose.yml` этого проекта должен быть задан `AUTH_ISSUER` — без него
   сервер не стартует (проверять токены нечем).
3. Пользователь нажимает «Войти», попадает на страницу auth-сервиса и там
   регистрируется или входит. Регистрацией/паролями управляет auth
   (`adduser`, `passwd`, `REGISTER_CODE`, `REGISTER_CLOSED` — всё там).

Существующие пользователи «Финансов» переносятся в auth одной командой с сохранением
паролей — см. `AUTH-INTEGRATION.md`.

### Обновление в будущем

Собрали новую версию → `docker build ... && docker push ...` (шаг 1) → на сервере
`cd ~/finance && sudo docker compose pull && sudo docker compose up -d`. Данные (том
`finance-data`) при этом не трогаются.

**Или автоматически** — см. «CI/CD: авто-деплой по пушу» ниже, если настроен GitHub
Actions, всё это (сборка образа + обновление на сервере) происходит само при пуше в
`master`.

---

## CI/CD: авто-деплой по пушу в master

`.github/workflows/deploy.yml` при каждом пуше в `master` (кроме правок в `*.md`,
`deploy/` и `demo-data.json`) сам собирает образ, пушит его в Docker Hub
(`shadowkick/finance:latest`) и по SSH на сервере выполняет `docker compose pull && up
-d`. Работает через два джоба: `build-and-push` (собирает и пушит образ), затем
`deploy` (ждёт первый, обновляет контейнер по SSH) — если сборка упала, деплой не
запустится.

Нужно один раз задать секреты репозитория (Settings → Secrets and variables → Actions):

| Секрет | Значение |
|---|---|
| `DOCKERHUB_USERNAME` | логин на Docker Hub |
| `DOCKERHUB_TOKEN` | **Access Token**, не пароль аккаунта — создаётся на hub.docker.com → Account Settings → Security → New Access Token (право Read & Write достаточно) |
| `SSH_HOST` | IP или домен сервера |
| `SSH_USER` | пользователь для SSH-входа (тот, под которым лежит `~/finance` и есть доступ к docker) |
| `SSH_KEY` | приватный ключ целиком (например, содержимое `id_ed25519`, включая `-----BEGIN...` строки) |
| `SSH_PORT` | порт SSH, если не стандартный 22 (необязательно) |

Ключ лучше завести отдельный, только для деплоя (не личный):

```bash
ssh-keygen -t ed25519 -f deploy_key -N ""   # локально, две строки: deploy_key (приватный) и deploy_key.pub
```

Публичную часть (`deploy_key.pub`) добавить на сервере в
`~/.ssh/authorized_keys` пользователя `SSH_USER`, приватную (`deploy_key`, весь файл
целиком) — в секрет `SSH_KEY`. Локальные копии после этого можно удалить.

Пользователь `SSH_USER` должен уметь выполнять `docker compose` без пароля — либо он в
группе `docker` (`sudo usermod -aG docker <юзер>`, затем перелогиниться), либо это
`root`. Workflow ничего не спрашивает интерактивно, так что `sudo` с запросом пароля не
сработает.

## Хранилище: SQLite

Данные лежат в `data/store.db` — SQLite через встроенный в Node.js модуль `node:sqlite`
(ничего дополнительно ставить не нужно, но версия Node важна: **24 и новее**, на более
старых модуль либо отсутствует, либо экспериментальный и может вести себя нестабильно).

У каждого пользователя своя строка в базе, обновляется независимо от остальных — в
отличие от более раннего формата (один общий JSON-файл, который целиком перезаписывался
при изменении любого пользователя), это нормально масштабируется даже при открытой
для всех регистрации.

Если на сервере уже был старый `data/store.json` — при первом запуске новой версии
сервер сам перенесёт данные в `store.db`, а старый файл переименует в
`store.json.migrated` (не удаляет, на всякий случай). Об этом будет строка в логах.

Экспорт/импорт данных **внутри самого приложения** («Сохранить копию» / «Загрузить
копию» в интерфейсе) как был в формате JSON, так и остался — это отдельный, чисто
клиентский механизм, серверного хранилища не касается.

### Резервная копия

Файл активно используется сервером, поэтому не просто копируйте его — используйте
`.backup`, он даёт консистентный снимок на лету, без остановки сервиса:

```bash
# Docker:
docker run --rm -v moi-finansy_finance-data:/data -v $(pwd):/backup alpine sh -c \
  "apk add --no-cache sqlite && sqlite3 /data/store.db '.backup /backup/finance-backup-$(date +%F).db'"

# без Docker:
sudo apt install -y sqlite3   # один раз
sqlite3 /opt/finance/data/store.db ".backup ~/finance-backup-$(date +%F).db"
```

---

## Путь 2: без Docker (bare-metal + systemd)

Если Docker на сервере не нужен или нежелателен — то же самое, но напрямую.

**1. Node.js 24+ и nginx:**

```bash
sudo apt update && sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v24.x — важно для SQLite, см. выше
```

**2. Скопируйте файлы приложения** (`index.html`, `server.js`, `assets/`) в `/opt/finance`
и заведите системного пользователя без входа:

```bash
sudo mkdir -p /opt/finance/data
sudo cp -r index.html server.js assets /opt/finance/
sudo useradd -r -s /usr/sbin/nologin finance
sudo chown -R finance:finance /opt/finance
```

**3. Служба systemd** — шаблон уже готов в `deploy/finance.service`:

```bash
sudo cp deploy/finance.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now finance
sudo systemctl status finance      # active (running)
curl -s http://127.0.0.1:8787/api/health   # {"ok":true}
```

**4. DNS, сертификат, nginx** — те же шаги 5–6 из пути с Docker (проверка портов,
`certbot certonly --standalone`, конфиг nginx с `proxy_pass http://127.0.0.1:8787`).
Обычный (не занятый VPN) генерический конфиг на порт 80/443 — в `deploy/nginx-finance.conf`,
если 443 свободен и переносить приложение на отдельный порт не требуется.

**5. Первый пользователь** — через auth-сервис (см. шаг 7 выше); в окружении сервиса
обязательно задайте `AUTH_ISSUER=https://auth.burninghouse.ru`.

### Обновление

Скопируйте изменившиеся файлы в `/opt/finance/`, затем `sudo systemctl restart finance`.
Данные (`data/store.db`) не трогаются.

---

## Полезные команды

```bash
# Docker:
docker compose ps                              # статус
docker compose logs -f finance                 # логи
docker exec finance node server.js states      # чьи данные лежат в базе
docker compose down                            # остановить (данные сохранятся)
docker compose down -v                         # остановить И стереть данные (осторожно!)

# bare-metal:
sudo systemctl status finance
sudo journalctl -u finance -f
sudo -u finance node /opt/finance/server.js states

# аккаунты — в auth-сервисе:
docker compose exec auth node server.js users
docker compose exec auth node server.js passwd <логин> <пароль>
```

## Переменные окружения сервера

Полный список — в шапке `server.js`. Основные:

- `PORT`, `HOST`, `DATA_DIR` — где слушать и куда писать данные.
- `AUTH_ISSUER` — **обязательно**: адрес auth-сервиса. Он же попадает в токены как
  `iss` и сверяется побайтово; без него сервер не стартует.
- `AUTH_CLIENT_ID` (по умолчанию `finance`) — под каким именем сервис зарегистрирован в auth.
- `AUTH_BASE` — куда фронт уводит на вход, если он отличается от `AUTH_ISSUER`
  (нужно, только когда сервер ходит в auth по внутреннему адресу).
- `ALLOWED_ORIGIN` — включает CORS для `/api/*`. Нужен, только если фронтенд и сервер
  когда-нибудь снова окажутся на разных доменах (сейчас не так — всё на одном).

## Как это работает вкратце

- Открыли `index.html` двойным кликом (`file://`) — работает офлайн, данные в браузере,
  логина не спросит.
- Открыли по `https://` — приложение уводит на страницу входа общего auth-сервиса,
  возвращается с токеном и синхронизирует данные на все устройства. Если вы уже вошли
  в другой проект BurningHouse, пароль спрашивать не будут.
- Пароли этот сервис не видит вовсе: он получает подписанный токен и проверяет подпись
  локально по публичному ключу auth-сервиса. Токен доступа живёт 15 минут и обновляется
  молча; фоновый refresh-токен — 60 дней и отзывается из личного кабинета.
