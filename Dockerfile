FROM node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY admin-assets ./admin-assets
COPY css ./css
COPY js ./js
COPY public-assets ./public-assets
COPY service-worker.js ./
COPY server ./server
COPY 404.html admin.html admin-platform.html index.html ./
RUN mkdir -p /app/uploads && chown node:node /app/uploads

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
