require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const { logger, httpLogger } = require('./logger');
const { setLatestQr, setIsReady, setGroups, setGroupDetails } = require('./state');
const { upsertGroup, insertGroupMessage, insertGroupHistoryIfChanged } = require('./db');
const webRouter = require('./routes/web');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(httpLogger);
app.use(express.urlencoded({ extended: false }));

const client = new Client({
    authStrategy: new LocalAuth(),
});

function buildMessageMetadata(msg, chat) {
    try {
        const safe = (value) => {
            try { return value === undefined ? null : value; } catch { return null; }
        };
        const base = {
            messageId: safe(msg.id?._serialized || msg.id),
            chatId: safe(chat?.id?._serialized),
            from: safe(msg.from),
            to: safe(msg.to),
            author: safe(msg.author),
            deviceType: safe(msg.deviceType),
            fromMe: safe(msg.fromMe),
            hasMedia: safe(msg.hasMedia),
            type: safe(msg.type),
            ack: safe(msg.ack),
            timestamp: safe(msg.timestamp),
            isStatus: safe(msg.isStatus),
            isStarred: safe(msg.isStarred),
            broadcast: safe(msg.broadcast),
            url: safe(msg.url),
            bodyLength: safe(msg.body ? msg.body.length : 0),
            mentionedIds: Array.isArray(msg.mentionedIds) ? msg.mentionedIds : [],
            quotedMsgId: safe(msg.hasQuotedMsg ? msg._data?.quotedMsgId || msg._data?.contextInfo?.stanzaId : null),
            location: msg.location ? {
                latitude: safe(msg.location.latitude),
                longitude: safe(msg.location.longitude),
                description: safe(msg.location.description),
                degrees: safe(msg.location.degrees),
            } : null,
            contact: msg.contact ? {
                id: safe(msg.contact.id?._serialized || msg.contact.id),
                number: safe(msg.contact.number),
                pushname: safe(msg.contact.pushname),
                name: safe(msg.contact.name),
                isBusiness: safe(msg.contact.isBusiness),
                isEnterprise: safe(msg.contact.isEnterprise),
            } : null,
            vCards: Array.isArray(msg.vCards) ? msg.vCards : [],
            links: Array.isArray(msg.links) ? msg.links : [],
            buttons: msg.buttons ? msg.buttons : null,
            list: msg.list ? msg.list : null,
            poll: msg.poll ? msg.poll : null,
            orderId: safe(msg.orderId),
            productId: safe(msg.productId),
            ephemeralOutOfSync: safe(msg.isEphemeralOutOfSync),
            ephemeralExpiration: safe(msg.ephemeralExpiration),
            mediaDataPresent: safe(msg._data?.mediaData != null),
            chatSnapshot: chat ? {
                name: safe(chat.name || chat.formattedTitle),
                isGroup: safe(chat.isGroup),
                unreadCount: safe(chat.unreadCount),
            } : null,
        };

        // Tenta enriquecer com dados crus (resumidos) quando possível
        const raw = msg?._data ? {
            subtype: safe(msg._data?.subtype),
            notifyName: safe(msg._data?.notifyName),
            isForwarded: safe(msg._data?.isForwarded),
            hasReaction: safe(msg._data?.hasReaction),
            contextInfoKeys: safe(Object.keys(msg._data?.contextInfo || {})),
        } : null;
        if (raw) base.raw = raw;

        return base;
    } catch (e) {
        return { error: 'metadata_build_failed' };
    }
}

client.on('qr', (qr) => {
    setLatestQr(qr);
    setIsReady(false);
    logger.info({ port: PORT }, 'QR recebido. Acesse http://localhost:%d para escanear.', PORT);
});

client.on('ready', async () => {
    setIsReady(true);
    logger.info('Cliente pronto (conectado).');
    try {
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

                // Persistir grupo básico
                upsertGroup({ id: g.id, name: g.name });
                // Melhor captura de descrição
                let description = null;
                try {
                    // Tentativas em ordem de disponibilidade
                    description = chat?.description || chat?.groupMetadata?.desc || chat?.groupMetadata?.desc?.body || null;
                    if (!description && chat.getInfo) {
                        const md = await chat.getInfo();
                        description = md?.desc || md?.description || md?.descOwner || null;
                    }
                } catch (e) {
                    // ignora
                }
                const inserted = await insertGroupHistoryIfChanged({
                    groupId: g.id,
                    name: g.name,
                    usersCount: participants.length,
                    description,
                });
                if (inserted) {
                    logger.info({ groupId: g.id }, 'Snapshot de grupo inserido (mudança detectada)');
                }
            } catch (err) {
                logger.warn({ err, groupId: g.id }, 'Falha ao coletar detalhes do grupo');
            }
        }
        logger.info({ groups: groups.length }, 'Grupos atualizados e persistidos');
    } catch (err) {
        logger.error({ err }, 'Erro ao obter grupos');
    }
});

client.on('authenticated', () => {
    logger.info('Cliente autenticado.');
});

client.on('auth_failure', (msg) => {
    logger.error({ msg }, 'Falha na autenticação');
});

client.on('disconnected', (reason) => {
    logger.warn({ reason }, 'Cliente desconectado');
    setIsReady(false);
});

// Salvar apenas mensagens de grupos
client.on('message_create', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;
        upsertGroup({ id: chat.id._serialized, name: chat.name || chat.formattedTitle });
        const meta = buildMessageMetadata(msg, chat);
        insertGroupMessage({
            id: msg.id?._serialized || msg.id,
            groupId: chat.id._serialized,
            userId: msg.author || msg.from || null,
            body: msg.body,
            type: msg.type,
            timestamp: msg.timestamp,
            jsonDump: JSON.stringify(meta),
        });
    } catch (err) {
        logger.error({ err }, 'Erro ao salvar mensagem de grupo');
    }
});

client.on('message', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;
        upsertGroup({ id: chat.id._serialized, name: chat.name || chat.formattedTitle });
        const meta = buildMessageMetadata(msg, chat);
        insertGroupMessage({
            id: msg.id?._serialized || msg.id,
            groupId: chat.id._serialized,
            userId: msg.author || msg.from || null,
            body: msg.body,
            type: msg.type,
            timestamp: msg.timestamp,
            jsonDump: JSON.stringify(meta),
        });
    } catch (err) {
        logger.error({ err }, 'Erro ao salvar mensagem de grupo (fallback)');
    }
});

// Expor client para rotas
app.set('waClient', client);

app.use('/', webRouter);

app.listen(PORT, () => {
    logger.info({ url: `http://localhost:${PORT}` }, 'Servidor web disponível');
});

client.initialize();