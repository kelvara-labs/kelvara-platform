FROM node:22-alpine
WORKDIR /app
COPY scripts/cloudflare-cutover-gate.mjs ./cloudflare-cutover-gate.mjs
USER node
CMD ["node","cloudflare-cutover-gate.mjs"]
