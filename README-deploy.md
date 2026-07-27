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
| `<порт>` | `9443` | 443 занят xray (VLESS), 8443/udp занят Hysteria2 — см. «Проверьте порты» ниже |
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

Готовый файл под конкретно этот деплой (порт 9443, домен money.burninghouse.ru) лежит
в `deploy/nginx-finance-9443.conf` — можно взять как есть или как образец для своих
значений.

```bash
sudo cp deploy/nginx-finance-9443.conf /etc/nginx/sites-available/finance   # или свой файл с шаблона выше
sudo ln -s /etc/nginx/sites-available/finance /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow <порт>/tcp   # если включён firewall
```

Готово: `https://<домен>:<порт>` должен открыть страницу входа.

### Шаг 7. Первый пользователь

Просто откройте сайт и зарегистрируйтесь через форму («Нет аккаунта?
Зарегистрироваться») — отдельная команда не нужна. По умолчанию регистрация открыта
всем в интернете; если хотите закрыть её кодом-приглашением — раскомментируйте
`REGISTER_CODE` в `docker-compose.yml` (свой секрет вместо примера) и перезапустите
`docker compose up -d`. CLI-способ тоже работает, если понадобится создать пользователя
без доступа к сайту: `docker exec finance node server.js adduser <логин> <пароль>`.

### Обновление в будущем

Собрали новую версию → `docker build ... && docker push ...` (шаг 1) → на сервере
`cd ~/finance && sudo docker compose pull && sudo docker compose up -d`. Данные (том
`finance-data`) при этом не трогаются.

---

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

**5. Первый пользователь** — так же через регистрацию на сайте, либо
`sudo -u finance node /opt/finance/server.js adduser <логин> <пароль>`.

### Обновление

Скопируйте изменившиеся файлы в `/opt/finance/`, затем `sudo systemctl restart finance`.
Данные (`data/store.db`) не трогаются.

---

## Полезные команды

```bash
# Docker:
docker compose ps                              # статус
docker compose logs -f finance                 # логи
docker exec finance node server.js users       # список логинов
docker exec finance node server.js passwd <логин> <пароль>   # сменить пароль
docker compose down                            # остановить (данные сохранятся)
docker compose down -v                         # остановить И стереть данные (осторожно!)

# bare-metal:
sudo systemctl status finance
sudo journalctl -u finance -f
sudo -u finance node /opt/finance/server.js users
sudo -u finance node /opt/finance/server.js passwd <логин> <пароль>
```

## Переменные окружения сервера

Полный список — в шапке `server.js`. Основные:

- `PORT`, `HOST`, `DATA_DIR` — где слушать и куда писать данные.
- `FIN_USER` / `FIN_PASS` — создать первого пользователя автоматически при пустой базе.
- `REGISTER_CODE` — если задан, для регистрации через сайт нужен этот код (иначе открыта всем).
- `ALLOWED_ORIGIN` — включает CORS для `/api/*`. Нужен, только если фронтенд и сервер
  когда-нибудь снова окажутся на разных доменах (сейчас не так — всё на одном).

## Как это работает вкратце

- Открыли `index.html` двойным кликом (`file://`) — работает офлайн, данные в браузере,
  логина не спросит.
- Открыли по `https://` — приложение видит сервер, просит войти или зарегистрироваться,
  дальше синхронизирует данные на все устройства.
- Пароли хранятся хэшированными (scrypt), не в открытом виде. Токен входа живёт 60 дней.
