FROM node:22-alpine
WORKDIR /app/packages/observation-hub
COPY services/observation-hub/package.json ./
COPY services/observation-hub/src ./src
COPY services/observation-hub/web ./web
COPY services/observation-hub/migrations ./migrations
COPY services/contracts /app/packages/contracts
RUN mkdir -p /app/packages/observation-hub/node_modules/@kelvara && ln -s /app/packages/contracts /app/packages/observation-hub/node_modules/@kelvara/contracts
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7610 DATABASE_PATH=/data/kelvara-observation.sqlite
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 7610
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD node -e "fetch('http://127.0.0.1:7610/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","src/main.js"]
