FROM node:20-alpine

LABEL org.opencontainers.image.title="Harborwalk Reporting"
LABEL org.opencontainers.image.description="Daily revenue, covers and weather reporting for Destin Harborwalk"
LABEL org.opencontainers.image.source="https://github.com/wolfej4/Harborwalk-Reporting"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY index.html styles.css app.js ./public/

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
