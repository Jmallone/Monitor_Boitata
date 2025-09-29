# Monitor_Boitata

Aplicação Node.js que monitora grupos do WhatsApp usando `whatsapp-web.js`, expondo uma interface web simples com QR Code e listagem de grupos. As mensagens e snapshots de grupos são persistidos em SQLite por padrão (ou PostgreSQL opcional).

## Requisitos
- Node.js 18+ (recomendado 20)
- NPM 9+
- Para execução com WhatsApp Web, é necessário um navegador Chromium/Chrome disponível. No Docker já incluímos isso.

## Configuração
Crie um arquivo `.env` (ou use variáveis de ambiente) com, no mínimo:

```
PORT=3000
# Banco de dados (padrão: sqlite)
DB_CLIENT=sqlite
# Caminho do arquivo do SQLite:
# - Local (sem Docker): use o padrão (não defina DB_PATH) ou defina DB_PATH=./data.sqlite
# - Docker: defina DB_PATH=/data/data.sqlite (mapeado em volume)
DB_PATH=./data.sqlite

# Se usar PostgreSQL, defina:
# DB_CLIENT=postgres
# PGHOST=...
# PGPORT=5432
# PGDATABASE=...
# PGUSER=...
# PGPASSWORD=...
# PGSSL=false
```

## Executar localmente
```
npm ci
npm start
```
Acesse `http://localhost:3000` e escaneie o QR Code com o WhatsApp do celular (Configurações → Dispositivos conectados → Conectar um dispositivo).

## Docker
Fornecemos um `Dockerfile` pronto para uso (compatível com Portainer).

### Build e run com Docker CLI
```
# Build
docker build -t monitor-boitata:latest .

# Executar com volumes para persistência da sessão e banco de dados
# Ajuste a porta e o caminho de volume conforme necessário
mkdir -p ./volumes/data ./volumes/wweb_auth ./volumes/wweb_cache

docker run -d \
  --name monitor-boitata \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DB_CLIENT=sqlite \
  -e DB_PATH=/data/data.sqlite \
  -v $(pwd)/volumes/data:/data \
  -v $(pwd)/volumes/wweb_auth:/app/.wwebjs_auth \
  -v $(pwd)/volumes/wweb_cache:/app/.wwebjs_cache \
  monitor-boitata:latest
```
Acesse `http://localhost:3000` para escanear o QR. O healthcheck está disponível em `/status`.

### Uso no Portainer
- Crie um novo container usando a imagem `monitor-boitata:latest` (ou publique em um registry de sua preferência e use a tag do registry).
- Mapeie a porta `3000` do container para a porta desejada no host.
- Configure as variáveis de ambiente:
  - `NODE_ENV=production`
  - `PORT=3000` (ou outra, mas lembre de ajustar o mapeamento de portas)
  - `DB_CLIENT=sqlite` (padrão) ou `postgres`
  - `DB_PATH=/data/data.sqlite` (se sqlite)
- Adicione os volumes para persistência:
  - `/data` → volume no host (para `data.sqlite`)
  - `/app/.wwebjs_auth` → volume no host (mantém sessão autenticada do WhatsApp)
  - `/app/.wwebjs_cache` → volume no host

### Observações importantes
- Em ambientes containerizados, o `whatsapp-web.js` usa Chromium headless com flags `--no-sandbox` por padrão (configuradas pela env `WWEBJS_PUPPETEER_ARGS`).
- Na primeira inicialização será necessário escanear o QR Code. Com os volumes configurados, a sessão será reutilizada nas próximas execuções.

## Rotas principais
- `GET /` → status, QR Code (quando não conectado) e lista de grupos (quando conectado)
- `GET /qr.png` → imagem do QR Code
- `GET /status` → healthcheck `{ ready: boolean, hasQr: boolean }`
- `POST /refresh` → força atualização da lista de grupos e métricas
- `POST /groups/:id/clear` → limpar mensagens do grupo
- `POST /groups/:id/leave` → sair do grupo
- `POST /groups/:id/delete` → excluir conversa do grupo

## Licença
ISC