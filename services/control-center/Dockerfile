FROM node:22-alpine
WORKDIR /app/packages/control-plane
COPY services/control-center/package.json ./
COPY services/control-center/src ./src
COPY services/contracts /app/packages/contracts
COPY services/indexer-kamino /app/packages/indexer-kamino
COPY services/indexer-velocity-src.js /app/packages/indexer-velocity/src/index.js
COPY services/indexer-velocity-package.json /app/packages/indexer-velocity/package.json
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7651 DATABASE_PATH=/data/kelvara-control-plane.sqlite
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 7651
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD node -e "fetch('http://127.0.0.1:7651/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","src/main.js"]
