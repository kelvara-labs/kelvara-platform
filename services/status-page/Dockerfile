FROM node:22-alpine
WORKDIR /app
COPY services/status-page/package.json ./
COPY services/status-page/*.js services/status-page/*.html services/status-page/*.css services/status-page/*.png ./
COPY services/status-page/assets ./assets
RUN mkdir -p /data && chown -R node:node /data
ENV HOST=0.0.0.0 PORT=8090 STATUS_DATABASE_PATH=/data/status.sqlite
USER node
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","server.js"]
