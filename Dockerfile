FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="Harborwalk Reporting"
LABEL org.opencontainers.image.description="Daily revenue, covers and weather reporting for Destin Harborwalk"
LABEL org.opencontainers.image.source="https://github.com/wolfej4/Harborwalk-Reporting"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css app.js /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
