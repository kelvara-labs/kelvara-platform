FROM node:22-alpine
WORKDIR /app/packages/indexer-velocity
COPY services/indexer-velocity/package.json ./
COPY services/indexer-velocity/src ./src
COPY services/contracts /app/packages/contracts
RUN mkdir -p /app/packages/indexer-velocity/node_modules/@kelvara && ln -s /app/packages/contracts /app/packages/indexer-velocity/node_modules/@kelvara/contracts
RUN addgroup -S worker && adduser -S worker -G worker && chown -R worker:worker /app
USER worker
ENV NODE_ENV=production HEALTH_HOST=0.0.0.0 HEALTH_PORT=7623
EXPOSE 7623
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 CMD node -e "fetch('http://127.0.0.1:7623/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","src/worker.js"]
