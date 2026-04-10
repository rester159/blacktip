# syntax=docker/dockerfile:1.6
#
# BlackTip production Docker image.
#
# Runs real Chrome Stable under Xvfb (virtual framebuffer) so the browser
# renders headful even on a headless server. BlackTip's stealth layer
# requires headful Chrome; "headless mode" is detectable at many
# fingerprint levels and is not supported.
#
# Build:
#   docker build -t blacktip:latest .
#
# Run the serve mode (TCP command server on port 9779):
#   docker run --rm -it \
#     --shm-size=2gb \
#     -p 9779:9779 \
#     -v $(pwd)/logs:/app/logs \
#     blacktip:latest
#
# Send commands from the host (or another container on the same network):
#   docker run --rm --network=host node:20-slim \
#     npx @rester159/blacktip send "await bt.navigate('https://example.com')" --pretty
#
# Architecture notes:
#   - Base is node:20-slim (Debian bookworm). Chrome only has x86_64
#     Linux packages — ARM64 hosts need to use patchright's bundled
#     Chromium instead (see deploy/README.md).
#   - --shm-size=2gb is REQUIRED at run time. Docker's default /dev/shm
#     is 64 MB which causes Chrome to crash under load.
#   - Xvfb runs on :99 with a 1920x1080x24 screen. DISPLAY=:99 is set
#     so all child processes (Chrome) find it.
#   - Runs as non-root user `blacktip` for safety. Chrome sandbox needs
#     SYS_ADMIN cap OR disabling the sandbox via --no-sandbox (less
#     secure). This image uses the sandbox; add --cap-add=SYS_ADMIN
#     when running if sandbox is enforced.

FROM node:20-slim AS runtime

# ── System dependencies ──
# Chrome's runtime deps, Xvfb, and the font packages a typical desktop
# Chrome would have (so document.fonts.check() matches declared profile).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        gnupg \
        xvfb \
        dbus \
        dbus-x11 \
        tini \
        # Chrome runtime deps
        libnss3 \
        libatk-bridge2.0-0 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libgbm1 \
        libxss1 \
        libasound2 \
        libxshmfence1 \
        libgtk-3-0 \
        libpango-1.0-0 \
        libcairo2 \
        libcups2 \
        libu2f-udev \
        libvulkan1 \
        # Fonts — matches what a real Windows/desktop Chrome has available
        fonts-liberation \
        fonts-noto \
        fonts-noto-cjk \
        fonts-dejavu-core \
        fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

# ── Google Chrome Stable ──
# We specifically install Chrome Stable (not Chromium) because BlackTip
# uses `channel: 'chrome'` to launch it, which gives us the authentic
# Chrome TLS ClientHello (with GREASE rotation) that anti-bot vendors
# fingerprint against. Chromium has a distinct TLS fingerprint that
# leaks via tls.peet.ws and similar.
RUN wget -qO /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
    && rm -rf /tmp/google-chrome.deb /var/lib/apt/lists/*

# Sanity check: verify Chrome can launch
RUN google-chrome --version

# ── Non-root user ──
RUN groupadd -r blacktip \
    && useradd -r -g blacktip -G audio,video blacktip \
    && mkdir -p /home/blacktip/Downloads \
    && chown -R blacktip:blacktip /home/blacktip

# ── App directory ──
WORKDIR /app
RUN chown blacktip:blacktip /app
USER blacktip

# Copy manifest first for better layer caching
COPY --chown=blacktip:blacktip package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source and build
COPY --chown=blacktip:blacktip tsconfig.json ./
COPY --chown=blacktip:blacktip src ./src
RUN npx tsc

# Install patchright's bundled Chromium as a fallback
RUN npx patchright install chromium || true

# Runtime environment
ENV DISPLAY=:99
ENV TZ=America/New_York
ENV NODE_ENV=production
# Chrome uses /dev/shm for IPC. This is a hint; Docker's --shm-size
# flag at run time is what actually controls the size.
ENV CHROMIUM_FLAGS="--disable-dev-shm-usage"

EXPOSE 9779

# Tini for proper signal handling (SIGTERM → graceful shutdown of Xvfb + Node)
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default: start Xvfb and launch BlackTip serve mode on port 9779.
# Override the command to run your own BlackTip-consuming app.
CMD ["/bin/sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp & sleep 1 && exec node dist/cli.js serve --port 9779"]
