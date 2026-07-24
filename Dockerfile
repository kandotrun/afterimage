FROM node:22-slim

ARG INSTALL_LOCAL_WHISPER=1

# ffmpeg and Python power the ingest pipeline.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/afterimage

# Python providers are lazy-loaded. Local Whisper is optional for lightweight images/CI.
COPY scripts/requirements*.txt ./scripts/
RUN python3 -m venv .venv && \
    .venv/bin/pip install --no-cache-dir -r scripts/requirements.txt && \
    if [ "$INSTALL_LOCAL_WHISPER" = "1" ]; then \
      .venv/bin/pip install --no-cache-dir -r scripts/requirements-whisper.txt; \
    fi

# Reproducible Node install, including the audited transitive override.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY scripts/ ./scripts/

ENV PATH="/opt/afterimage/.venv/bin:/opt/afterimage/node_modules/.bin:${PATH}" \
    AFTERIMAGE_ROOT=/data \
    HOST=0.0.0.0 \
    PORT=8901 \
    STT_PROVIDER=none
ENV PATH="/opt/afterimage/.venv/bin:${PATH}"

EXPOSE 8901

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8901)+'/_health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
