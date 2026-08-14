# ---- Stage 1: Build ----
FROM node:20-alpine AS builder
WORKDIR /app

# QEMU amd64 no Mac corta o registry a meio do Next; retries evitam o ECONNRESET.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Stage 2: Runner ----
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8001
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

# Instala dependências de produção (tsx está em dependencies)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Build do Next.js
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.js ./
COPY --from=builder /app/tsconfig.json ./

# Código-fonte necessário em runtime (servidor custom + lib importada pelo servidor)
COPY --from=builder /app/server ./server
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/types ./types

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://localhost:8001/ || exit 1

CMD ["node", "--import", "tsx", "server/index.ts"]
