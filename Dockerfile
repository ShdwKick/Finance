# Мои финансы — один образ на всё: статика + сервер синхронизации.
# Зависимостей нет (server.js — чистый Node.js, хранилище — встроенный node:sqlite,
# ставить ничего не нужно). node:24 — минимум для стабильного node:sqlite.
# Аккаунты живут в общем auth-сервисе; здесь только проверка его токенов
# (auth-client.js — копия из репозитория Auth, тоже без зависимостей).

FROM node:24-alpine

WORKDIR /app

# Копируем только то, что реально нужно в рантайме
COPY server.js ./
COPY auth-client.js ./
COPY index.html ./
COPY assets/ ./assets/

# Каталог для данных (пользователи + финансовые записи).
# В контейнере он будет примонтирован как volume — см. docker-compose.yml.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/app/data

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "server.js"]
