# Node.js + Debian Chromium (invoice PDF) + Japanese fonts.
# Same file for linux/amd64 and linux/arm64. Classic Dockerfile syntax only (no BuildKit-only features).
FROM node:24-trixie-slim

# chromium pulls in every shared library it needs as package dependencies.
# fonts-ipafont-gothic: fixed-width Japanese font (metric-compatible stand-in for MS Gothic)
# fonts-noto-cjk:       fallback for characters IPAGothic does not have
# tini:                 small init process (reaps Chromium child processes, forwards stop signals)
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium \
      fonts-ipafont-gothic \
      fonts-noto-cjk \
      fontconfig \
      tini \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

# The invoice HTML asks for "MS Gothic", "Meiryo", monospace. Map them to IPAGothic.
# Both fc-match lines must print:  ipag.ttf: "IPAGothic" "Regular"
COPY docker/fonts-local.conf /etc/fonts/local.conf
RUN fc-cache -f && fc-match "MS Gothic" && fc-match monospace

# Must be set before "npm ci": do not download Puppeteer's own Chrome, use the Chromium installed above.
ENV TZ=Asia/Tokyo \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

# Entrypoint: fixes the owner of the data volume, then drops root (see docker/entrypoint.sh).
# sed removes Windows line endings in case the file was saved with CRLF.
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod 755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/data \
 && chown node:node /app/data

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
