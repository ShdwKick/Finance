# Развёртывание «Мои финансы» на сервере Ubuntu 24.04

Приложение = один статический файл `index.html` + маленький сервер синхронизации
`server.js` (чистый Node.js, **без npm install**, без внешних зависимостей).
Данные всех устройств хранятся на сервере в `data/store.json`, вход по логину и паролю.

Итог: `https://money.ВАШ-ДОМЕН` — открывается и с телефона, и с ПК, данные общие.

---

## 0. Не сломает ли это VPN (hysteria + 3x-ui)?

Нет, если правильно занять порты. Проверьте, что слушается на TCP 80/443:

```bash
sudo ss -tlnp | grep -E ':(80|443)\b'
```

- **Hysteria2** работает по **UDP/443** (QUIC) — nginx на **TCP** ему не мешает.
- **3x-ui**: сама панель на своём порту (её не трогаем). Но если в 3x-ui есть
  входящий **Reality/VLESS на TCP 443**, то TCP 443 занят — см. «Вариант Б» ниже.

Если в выводе выше **TCP 80 и 443 свободны** → делайте по основному пути (Вариант А).
Если **TCP 443 занят** (xray/reality) → Вариант Б (приложение на порту 8443).

---

## Способ деплоя: bare-metal или Docker?

Ниже два независимых пути установить само приложение (шаги 1–4). Дальше (DNS,
nginx, HTTPS — шаги 5–6) — одинаково для обоих. Выбирайте один:

- **Bare-metal** (Node.js прямо на сервере, systemd) — шаги 1–4 ниже как есть.
- **Docker** — см. отдельный раздел «Деплой через Docker» в конце файла, затем
  сразу переходите к шагам 5–6.

---

## 1. Установить Node.js и nginx

```bash
sudo apt update
sudo apt install -y nginx
# Node.js 20 LTS из репозитория NodeSource:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # должно показать v20.x
```

## 2. Скопировать файлы на сервер

Приложение теперь состоит из нескольких файлов (`index.html`, `server.js` и папка
`assets/`), поэтому копируем папку целиком. С вашего ПК (PowerShell), замените `SERVER_IP`:

```powershell
scp -r "F:\Рабэта\Финансы" root@SERVER_IP:/tmp/finance
```

На сервере:

```bash
sudo mkdir -p /opt/finance
sudo cp -r /tmp/finance/index.html /tmp/finance/server.js /tmp/finance/assets /opt/finance/
sudo useradd -r -s /usr/sbin/nologin finance   # системный пользователь без входа
sudo mkdir -p /opt/finance/data
sudo chown -R finance:finance /opt/finance
```

> Структура на сервере: `/opt/finance/{index.html, server.js, assets/{styles.css,core.js,app.js}, data/}`.
> Сервер отдаёт наружу только `index.html` и `assets/*`; папки `data/` (с паролями) и
> сам `server.js` через веб недоступны.

## 3. Создать пользователя приложения (логин/пароль для входа в сайт)

```bash
cd /opt/finance
sudo -u finance node server.js adduser myname 'МойСильныйПароль'
# добавить второго (например, для жены/партнёра, общие данные — тот же логин;
# отдельные данные — отдельный логин):
# sudo -u finance node server.js adduser second 'ДругойПароль'
```

## 4. Запустить как службу (systemd)

```bash
sudo cp /opt/finance/deploy/finance.service /etc/systemd/system/   # или создайте файл вручную (см. deploy/finance.service)
sudo systemctl daemon-reload
sudo systemctl enable --now finance
sudo systemctl status finance      # должно быть active (running)
curl -s http://127.0.0.1:8787/api/health   # {"ok":true}
```

> Файл `finance.service` лежит в папке `deploy/`. Если копировали только index.html и
> server.js — просто создайте `/etc/systemd/system/finance.service` с его содержимым.

## 5. DNS: поддомен

У регистратора домена добавьте **A-запись**:
`money` → IP вашего сервера (тот же, что у VPN-домена, это нормально).
Дождитесь распространения (обычно минуты): `ping money.ВАШ-ДОМЕН`.

## 6. nginx + HTTPS

### Вариант А — TCP 80/443 свободны (обычный случай)

```bash
# конфиг (замените money.example.com на свой поддомен в файле):
sudo cp /opt/finance/deploy/nginx-finance.conf /etc/nginx/sites-available/finance
sudo nano /etc/nginx/sites-available/finance     # поправьте server_name
sudo ln -s /etc/nginx/sites-available/finance /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# бесплатный сертификат Let's Encrypt (сам пропишет HTTPS-блок и редирект):
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d money.ВАШ-ДОМЕН
```

Готово: откройте `https://money.ВАШ-ДОМЕН`.

### Вариант Б — TCP 443 занят Reality/xray

Разместите приложение на **TCP 8443** (443 остаётся у VPN). В конфиге nginx
замените `listen 80;`/`listen [::]:80;` и добавьте TLS вручную, либо проще —
получите сертификат в режиме webroot/standalone и слушайте 8443:

```bash
# 1) временно откройте 80 только для выдачи сертификата (если 80 свободен):
sudo certbot certonly --standalone -d money.ВАШ-ДОМЕН
# сертификат появится в /etc/letsencrypt/live/money.ВАШ-ДОМЕН/
```

Затем конфиг nginx на 8443 (создайте /etc/nginx/sites-available/finance):

```nginx
server {
    listen 8443 ssl;
    listen [::]:8443 ssl;
    server_name money.ВАШ-ДОМЕН;
    ssl_certificate     /etc/letsencrypt/live/money.ВАШ-ДОМЕН/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/money.ВАШ-ДОМЕН/privkey.pem;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/finance /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 8443/tcp   # если включён firewall
```

Открывать: `https://money.ВАШ-ДОМЕН:8443`.

---

## Обновление приложения в будущем

Скопируйте изменившиеся файлы — `index.html`, папку `assets/` и/или `server.js` — в
`/opt/finance/`, затем:

```bash
sudo chown -R finance:finance /opt/finance/index.html /opt/finance/assets /opt/finance/server.js
sudo systemctl restart finance
```

Данные пользователей (`data/store.json`) при этом не трогаются.

## Резервная копия данных

```bash
sudo cp /opt/finance/data/store.json ~/finance-backup-$(date +%F).json
```

## Полезные команды

```bash
sudo systemctl status finance         # состояние
sudo journalctl -u finance -f         # логи в реальном времени
sudo -u finance node /opt/finance/server.js users     # список логинов
sudo -u finance node /opt/finance/server.js passwd myname 'НовыйПароль'  # смена пароля
```

## Как это работает (кратко)

- Открыли `index.html` **двойным кликом** (file://) → работает офлайн, данные в браузере
  (как раньше). Логин не спрашивается.
- Открыли по `https://…` → приложение видит сервер, просит логин, тянет данные с сервера
  и на каждое изменение отправляет их обратно. На всех устройствах — одни и те же данные.
- Пароли хранятся не в открытом виде (scrypt-хэш). Токен входа живёт 60 дней.

---

## Деплой через Docker (альтернатива шагам 1–4)

Один образ, без внешних зависимостей (в `server.js` их и так нет). Проверено вживую:
сборка, `docker compose up`, создание пользователя, рестарт с сохранением данных
в volume — всё отработало на этой машине перед тем, как эти файлы попали в репозиторий.

### Установка Docker на сервере (если ещё нет)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # затем перелогиньтесь, либо каждую команду через sudo
```

### Запуск

```bash
cd /opt/finance   # или куда скопировали репозиторий
docker compose up -d --build
docker compose logs -f finance   # Ctrl+C для выхода из просмотра логов, контейнер продолжит работать
```

По умолчанию контейнер слушает **только на 127.0.0.1:8787** — снаружи не виден,
как и bare-metal-вариант. Наружу отдаёт nginx (шаги 5–6 выше, `proxy_pass
http://127.0.0.1:8787;` — без изменений).

### Создать пользователя

```bash
docker exec finance node server.js adduser myname 'МойСильныйПароль'
```

Сработает сразу, без перезапуска контейнера — сервер подхватывает новых
пользователей "на лету" при следующей попытке входа.

Либо ещё проще — задать первого пользователя через переменные окружения
**до первого запуска** (создаст пользователя автоматически, если база пуста):
раскомментируйте `FIN_USER`/`FIN_PASS` в `docker-compose.yml`, затем
`docker compose up -d --build`. После первого раза эти строки можно убрать —
на существующих пользователей они не влияют.

### Данные

Хранятся в именованном Docker-volume `finance-data`, монтируется в `/app/data`
внутри контейнера. Переживает `docker compose down` (без флага `-v`) и рестарты.
Резервная копия:

```bash
docker run --rm -v moi-finansy_finance-data:/data -v $(pwd):/backup alpine \
  cp /data/store.json /backup/finance-backup-$(date +%F).json
```

### Обновление приложения

```bash
cd /opt/finance
git pull            # если репозиторий на сервере
docker compose up -d --build
```

Данные (volume) при пересборке не трогаются.

### Полезные команды

```bash
docker compose ps                              # статус
docker compose logs -f finance                 # логи
docker exec finance node server.js users       # список логинов
docker exec finance node server.js passwd myname 'НовыйПароль'
docker compose down                            # остановить (данные сохранятся)
docker compose down -v                         # остановить И стереть данные (осторожно!)
```
