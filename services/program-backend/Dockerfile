FROM node:22-alpine AS deps
WORKDIR /app
COPY services/program-backend/package.json services/program-backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
FROM node:22-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY services/program-backend/package.json services/program-backend/package-lock.json ./
COPY services/program-backend/src ./src
COPY services/program-backend/subapps/kamino-monitor ./subapps/kamino-monitor
COPY services/program-backend/subapps/client-manager ./subapps/client-manager
COPY ui ./ui
COPY services/contracts /contracts
RUN mkdir -p /data/kamino-monitor && chown -R node:node /data
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 KELVARA_RUNTIME_DIR=/data/kamino-monitor
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","subapps/kamino-monitor/server.js"]
