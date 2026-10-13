FROM node:22-alpine
WORKDIR /app/packages/indexer-squads
COPY services/indexer-squads/package.json services/indexer-squads/package-lock.json ./
COPY services/indexer-squads/src ./src
COPY services/control-center/src/governance-subject-mapping-store.js /app/packages/control-center/src/governance-subject-mapping-store.js
COPY services/contracts /app/packages/contracts
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
RUN addgroup -S worker && adduser -S worker -G worker && mkdir -p /data && chown -R worker:worker /app /data
USER worker
ENV NODE_ENV=production HEALTH_HOST=0.0.0.0 HEALTH_PORT=7622
EXPOSE 7622
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 CMD node -e "fetch('http://127.0.0.1:7622/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","src/main.js"]
