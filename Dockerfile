# syntax=docker/dockerfile:1

# ---- Base de dependências ----
FROM node:20-bullseye AS deps
WORKDIR /app

# Instala dependências do sistema necessárias para o Chromium (whatsapp-web.js)
RUN apt-get update && apt-get install -y \
  chromium \
  ffmpeg \
  fonts-liberation \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libatspi2.0-0 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libpango-1.0-0 \
  libasound2 \
  libnss3 \
  libxshmfence1 \
  ca-certificates \
  build-essential \
  && rm -rf /var/lib/apt/lists/*

# Copia apenas manifestos para cache otimizado
COPY package*.json ./

# Instala apenas dependências de produção
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---- Build de runtime ----
FROM node:20-bullseye AS runner
WORKDIR /app

# Copia Chromium e libs do estágio anterior
COPY --from=deps /usr/bin/chromium /usr/bin/chromium
COPY --from=deps /usr/lib/ /usr/lib/
COPY --from=deps /lib/ /lib/
COPY --from=deps /usr/share/fonts /usr/share/fonts
COPY --from=deps /etc/ssl/certs /etc/ssl/certs

# Variáveis padrão
ENV NODE_ENV=production \
    PORT=3000 \
    DB_CLIENT=sqlite \
    DB_PATH=/data/data.sqlite \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_ARGS=--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu,--no-zygote,--single-process

# Diretórios de dados (persistência)
RUN mkdir -p /data /app/.wwebjs_auth /app/.wwebjs_cache \
  && chown -R node:node /data /app/.wwebjs_auth /app/.wwebjs_cache

# Copia node_modules de produção
COPY --from=deps /app/node_modules ./node_modules

# Copia código da aplicação
COPY . .

# Ajusta permissões do diretório de logs (caso exista no código-fonte)
RUN mkdir -p /app/logs && chown -R node:node /app/logs

# Evita falha do wrapper do Chromium ao tentar incluir arquivos em /etc/chromium.d
RUN mkdir -p /etc/chromium.d && touch /etc/chromium.d/empty.sh

# Cria usuário não-root
USER node

EXPOSE 3000

# Healthcheck simples na rota /status
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+ (process.env.PORT||3000) +'/status', r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Observação: whatsapp-web.js/Puppeteer requer flags no Chromium em ambientes containerizados
# As flags são passadas via variável WWEBJS_PUPPETEER_ARGS ou PUPPETEER_ARGS, mas aqui usamos default headless com no-sandbox.

ENV WWEBJS_PUPPETEER_ARGS=--no-sandbox,--disable-setuid-sandbox

# Volumes para persistência (mapeie no Portainer)
VOLUME ["/data", "/app/.wwebjs_auth", "/app/.wwebjs_cache"]

CMD ["npm", "start"] 