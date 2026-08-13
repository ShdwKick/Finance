FROM node:24-alpine

WORKDIR /app

# Копируем только то, что реально нужно в рантайме
COPY server.js ./
COPY auth-client.js ./
COPY admin-internal.js ./
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
