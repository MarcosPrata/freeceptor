# ---- Stage 1: Build ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run build

# ---- Stage 2: Runner ----
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8001

# Instala dependências de produção (tsx está em dependencies)
COPY package.json package-lock.json ./
RUN npm install --omit=dev

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
