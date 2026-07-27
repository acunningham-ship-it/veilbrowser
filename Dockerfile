# Veil MCP server, containerised.
#
# Glama's listing check needs the server to START and answer INTROSPECTION
# (initialize + tools/list) over stdio — that needs Node only, so the default image
# stays small and builds fast. Chromium is installed too, because a browser tool that
# cannot open a browser is a listing that lies about what it does.
#
#   docker build -t veil-mcp .
#   docker run --rm -i veil-mcp            # stdio MCP server
#
# NOTE ON STEALTH, stated plainly: a container is a WORSE fingerprint than a real
# desktop Chrome — no GPU, so WebGL falls back to SwiftShader, and there is no display
# unless you provide one. Use this for MCP wiring, CI and introspection. For actual
# stealth work run Veil on a host with a real GPU and an X display (see README).
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation xvfb dumb-init \
 && rm -rf /var/lib/apt/lists/*

# Veil finds Chrome by probing known paths; point it straight at the Debian binary.
ENV VEIL_CHROME=/usr/bin/chromium
# Headless in a container: there is no display by default. Override if you wire up Xvfb.
ENV VEIL_HEADLESS=1

WORKDIR /app
COPY package.json ./
COPY dist ./dist
COPY README.md LICENSE ./
RUN npm install --omit=dev --no-audit --no-fund

# dumb-init so SIGTERM reaches node and Chrome's process group gets reaped.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/mcp.js"]
