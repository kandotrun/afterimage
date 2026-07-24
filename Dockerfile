FROM node:22-slim

# ffmpeg for the ingest pipeline
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Python dependencies for ingest
COPY scripts/requirements.txt /opt/afterimage/scripts/requirements.txt
RUN python3 -m venv /opt/afterimage/.venv && \
    /opt/afterimage/.venv/bin/pip install --no-cache-dir -r /opt/afterimage/scripts/requirements.txt

# Node dependencies
WORKDIR /opt/afterimage
COPY package.json ./
RUN npm install --omit=dev

# Application code
COPY src/ ./src/
COPY scripts/ ./scripts/

ENV NODE_ENV=production
ENV AFTERIMAGE_MODE=lifelog
ENV HOST=0.0.0.0
ENV PORT=8901

EXPOSE 8901

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8901)+'/_health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
