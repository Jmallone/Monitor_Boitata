const express = require('express');
const QRCode = require('qrcode');
const { getIsReady, getLatestQr, getGroups, getGroupDetails, setGroups, setGroupDetails } = require('../state');
const { logger } = require('../logger');

const router = express.Router();

router.get('/', (req, res) => {
    const isReady = getIsReady();
    const latestQr = getLatestQr();
    const groups = getGroups();

    const listHtml = (items) => `
      <div class="list">
        <h3>Grupos (${items.length})</h3>
        <ul>
          ${items.map(g => `<li><a href="/groups/${encodeURIComponent(g.id)}">${g.name}</a></li>`).join('')}
        </ul>
      </div>
    `;

    const html = `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WhatsApp - Grupos</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; }
  .card { max-width: 900px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .status { margin-bottom: 16px; font-weight: 600; }
  .qr { display: flex; justify-content: center; }
  .muted { color: #6b7280; font-size: 14px; margin-top: 12px; text-align: center; }
  button { margin-top: 12px; padding: 8px 12px; border-radius: 8px; border: 1px solid #d1d5db; background: #f9fafb; cursor: pointer; }
  .list { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; max-height: 540px; overflow: auto; }
  .list h3 { margin-top: 0; font-size: 16px; }
  .list ul { margin: 0; padding-left: 18px; }
  .list li { line-height: 1.6; }
  .back { margin-top: 16px; display: inline-block; }
  .actions { margin-top: 16px; display: flex; gap: 8px; }
  .danger { background: #fee2e2; border-color: #fecaca; }
</style>
</head>
<body>
  <div class="card">
    <div class="status">Status: ${isReady ? 'Conectado ✅' : (latestQr ? 'Aguardando leitura do QR ⏳' : 'Inicializando...')}</div>
    ${isReady ? `
      ${listHtml(groups)}
    ` : ''}
    ${!isReady && latestQr ? `
      <div class="qr">
        <img src="/qr.png" alt="QR Code" width="300" height="300" />
      </div>
      <div class="muted">Abra o WhatsApp no celular → Configurações → Dispositivos conectados → Conectar um dispositivo e escaneie o QR acima.</div>
    ` : ''}
    <div style="text-align:center">
      <form method="POST" action="/refresh">
        <button type="submit">Atualizar</button>
      </form>
    </div>
  </div>
  <script>
    if (!${isReady}) {
      setTimeout(() => location.reload(), 10000);
    }
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

router.get('/groups/:id', (req, res) => {
    const isReady = getIsReady();
    if (!isReady) {
        res.redirect('/');
        return;
    }
    const groupId = req.params.id;
    const groups = getGroups();
    const group = groups.find(g => g.id === groupId);
    const details = getGroupDetails(groupId);

    if (!group) {
        res.status(404).send('Grupo não encontrado');
        return;
    }

    const html = `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${group.name} - Detalhes</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; }
  .card { max-width: 800px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .kv { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
  .kv h4 { margin: 0 0 8px 0; font-size: 14px; color: #374151; }
  .kv div { font-size: 16px; }
  .back { margin-top: 16px; display: inline-block; }
  .actions { margin-top: 16px; display: flex; gap: 8px; }
  .danger { background: #fee2e2; border-color: #fecaca; }
  form { display: inline; }
</style>
</head>
<body>
  <div class="card">
    <h2>${group.name}</h2>
    <div class="grid">
      <div class="kv"><h4>ID</h4><div>${group.id}</div></div>
      <div class="kv"><h4>Participantes</h4><div>${details ? details.participantsCount : '-'}</div></div>
      <div class="kv"><h4>Admins</h4><div>${details ? details.adminsCount : '-'}</div></div>
      <div class="kv"><h4>Não lidas</h4><div>${details ? details.unreadCount : '-'}</div></div>
    </div>

    <div class="actions">
      <form method="POST" action="/groups/${encodeURIComponent(group.id)}/clear">
        <button type="submit">Limpar mensagens</button>
      </form>
      <form method="POST" action="/groups/${encodeURIComponent(group.id)}/leave">
        <button type="submit" class="danger">Sair do grupo</button>
      </form>
      <form method="POST" action="/groups/${encodeURIComponent(group.id)}/delete">
        <button type="submit" class="danger">Excluir conversa</button>
      </form>
    </div>

    <a class="back" href="/">← Voltar</a>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// Atualizar grupos: revarrer chats e atualizar estado
router.post('/refresh', async (req, res) => {
    try {
        const client = req.app.get('waClient');
        const chats = await client.getChats();
        const groups = chats.filter(c => c.isGroup).map(c => ({
            id: c.id._serialized,
            name: c.name || c.formattedTitle,
        })).filter(g => g.name).sort((a, b) => a.name.localeCompare(b.name));
        setGroups(groups);

        for (const g of groups) {
            try {
                const chat = chats.find(c => c.id._serialized === g.id);
                const participants = chat.participants ? chat.participants.map(p => ({
                    id: p.id?._serialized || p.id,
                    isAdmin: Boolean(p.isAdmin || p.isSuperAdmin),
                })) : [];
                const unreadCount = chat.unreadCount || 0;
                setGroupDetails(g.id, {
                    id: g.id,
                    name: g.name,
                    participantsCount: participants.length,
                    adminsCount: participants.filter(p => p.isAdmin).length,
                    unreadCount,
                });
            } catch (err) {
                logger.warn({ err, groupId: g.id }, 'Falha ao coletar detalhes do grupo (refresh)');
            }
        }

        logger.info({ groups: groups.length }, 'Refresh de grupos concluído');
        res.redirect('/');
    } catch (err) {
        logger.error({ err }, 'Erro no refresh de grupos');
        res.status(500).send('Erro ao atualizar grupos');
    }
});

// Ações: limpar, sair, excluir
router.post('/groups/:id/clear', async (req, res) => {
    try {
        const groupId = req.params.id;
        const client = req.app.get('waClient');
        const chat = await client.getChatById(groupId);
        await chat.clearMessages();
        logger.info({ groupId }, 'Mensagens do grupo limpas');
        res.redirect(`/groups/${encodeURIComponent(groupId)}`);
    } catch (err) {
        logger.error({ err }, 'Erro ao limpar mensagens');
        res.status(500).send('Erro ao limpar mensagens do grupo');
    }
});

router.post('/groups/:id/leave', async (req, res) => {
    try {
        const groupId = req.params.id;
        const client = req.app.get('waClient');
        const chat = await client.getChatById(groupId);
        await chat.leave();
        logger.info({ groupId }, 'Saiu do grupo');
        res.redirect('/');
    } catch (err) {
        logger.error({ err }, 'Erro ao sair do grupo');
        res.status(500).send('Erro ao sair do grupo');
    }
});

router.post('/groups/:id/delete', async (req, res) => {
    try {
        const groupId = req.params.id;
        const client = req.app.get('waClient');
        const chat = await client.getChatById(groupId);
        await chat.delete();
        logger.info({ groupId }, 'Conversa do grupo excluída');
        res.redirect('/');
    } catch (err) {
        logger.error({ err }, 'Erro ao excluir conversa do grupo');
        res.status(500).send('Erro ao excluir conversa do grupo');
    }
});

router.get('/qr.png', async (req, res) => {
    try {
        const latestQr = getLatestQr();
        if (!latestQr) {
            res.status(404).send('QR não disponível no momento.');
            return;
        }
        const pngBuffer = await QRCode.toBuffer(latestQr, { type: 'png', margin: 1, width: 300 });
        res.setHeader('Content-Type', 'image/png');
        res.send(pngBuffer);
    } catch (err) {
        logger.error({ err }, 'Erro ao gerar QR');
        res.status(500).send('Erro ao gerar QR');
    }
});

router.get('/status', (req, res) => {
    res.json({ ready: getIsReady(), hasQr: Boolean(getLatestQr()) });
});

module.exports = router; 