# Build com o contexto na pasta relay/ (EasyPanel: caminho de build "relay"). O Node 22 roda o TypeScript direto.
FROM node:22.23.4-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY *.ts ./
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+process.env.HEALTH_PATH).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "main.ts"]
