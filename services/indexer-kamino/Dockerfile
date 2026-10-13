FROM node:22-alpine
WORKDIR /app/packages/indexer-kamino
COPY services/indexer-kamino/package.json ./
COPY services/indexer-kamino/src ./src
COPY services/contracts /app/packages/contracts
COPY services/solana-transport /app/packages/solana-transport
COPY services/package.json services/package-lock.json /app/packages/
RUN cd /app/packages && npm ci --omit=dev --ignore-scripts && mkdir -p /app/packages/indexer-kamino/node_modules/@kelvara && ln -s /app/packages/contracts /app/packages/indexer-kamino/node_modules/@kelvara/contracts
RUN addgroup -S worker && adduser -S worker -G worker && chown -R worker:worker /app
USER worker
ENV NODE_ENV=production HEALTH_HOST=0.0.0.0 HEALTH_PORT=7620
EXPOSE 7620
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 CMD node -e "fetch('http://127.0.0.1:7620/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","src/worker.js"]
