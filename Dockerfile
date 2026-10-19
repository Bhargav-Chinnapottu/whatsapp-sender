# WhatsApp Contact Sender — container image
#
# whatsapp-web.js drives a headless Chromium via Puppeteer. Rather than rely on
# Puppeteer's bundled Chromium (which often misses shared libs in slim images),
# we install the distro Chromium and point Puppeteer at it.

FROM node:20-bookworm-slim

# Install Chromium + the libraries headless Chrome needs at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxkbcommon0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip its own Chromium download and use the system one.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# App source.
COPY server.js ./
COPY public ./public

# Persist the WhatsApp auth session here; mount a volume at this path so the
# login survives container restarts (otherwise you re-scan the QR every time).
RUN mkdir -p /app/.wwebjs_auth
VOLUME ["/app/.wwebjs_auth"]

EXPOSE 3000

# Run as the non-root user that the node image already provides.
RUN chown -R node:node /app
USER node

CMD ["node", "server.js"]
