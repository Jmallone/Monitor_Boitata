require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const os = require('os');
const path = require('path');
let whisperFn = null;
try { whisperFn = require('whisper-node'); } catch (_) { whisperFn = null; }
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

async function transcribeIfPtt(msg) {
    try {
        if (msg.type !== 'ptt') return { body: msg.body, metaExtra: null };
        if (!whisperFn) return { body: msg.body, metaExtra: { transcription: { skipped: true, reason: 'no_whisper_node' } } };
        const media = await msg.downloadMedia();
        if (!media || !media.data) return { body: msg.body, metaExtra: { transcription: { skipped: true, reason: 'no_media' } } };
        const buffer = Buffer.from(media.data, 'base64');
        const mimetype = media.mimetype || 'audio/ogg';
        const ext = mimetype.includes('mp3') ? 'mp3' : (mimetype.includes('wav') ? 'wav' : (mimetype.includes('webm') ? 'webm' : 'ogg'));
        const tmpFile = path.join(os.tmpdir(), `ptt-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        fs.writeFileSync(tmpFile, buffer);
        try {
            const segments = await whisperFn(tmpFile);
            if (Array.isArray(segments) && segments.length > 0) {
                const text = segments.map(s => s && s.speech ? String(s.speech) : '').filter(Boolean).join(' ');
                const newBody = text ? `[PTT] ${text}` : msg.body;
                return { body: newBody, metaExtra: { transcription: { provider: 'whisper-node', ok: true, text, segments } } };
            }
            return { body: msg.body, metaExtra: { transcription: { skipped: true, reason: 'empty_transcript' } } };
        } catch (e) {
            return { body: msg.body, metaExtra: { transcription: { skipped: true, reason: 'whisper_error' } } };
        } finally {
            try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
    } catch (e) {
        return { body: msg.body, metaExtra: { transcription: { skipped: true, reason: 'exception' } } };
    }
}

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
    QRCode.toString(qr, { type: 'terminal', small: true })
        .then(str => {
            console.log('\n===== QR CODE (Terminal) =====\n');
            console.log(str);
            console.log('\n==============================\n');
        })
        .catch(() => {});
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

                upsertGroup({ id: g.id, name: g.name });
                let description = null;
                try {
                    description = chat?.description || chat?.groupMetadata?.desc || chat?.groupMetadata?.desc?.body || null;
                    if (!description && chat.getInfo) {
                        const md = await chat.getInfo();
                        description = md?.desc || md?.description || md?.descOwner || null;
                    }
                } catch (e) {}
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

client.on('message_create', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;
        upsertGroup({ id: chat.id._serialized, name: chat.name || chat.formattedTitle });
        const { body, metaExtra } = await transcribeIfPtt(msg);
        const meta = buildMessageMetadata(msg, chat);
        if (metaExtra) meta.transcription = metaExtra.transcription;
        insertGroupMessage({
            id: msg.id?._serialized || msg.id,
            groupId: chat.id._serialized,
            userId: msg.author || msg.from || null,
            body: body,
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
        const { body, metaExtra } = await transcribeIfPtt(msg);
        const meta = buildMessageMetadata(msg, chat);
        if (metaExtra) meta.transcription = metaExtra.transcription;
        insertGroupMessage({
            id: msg.id?._serialized || msg.id,
            groupId: chat.id._serialized,
            userId: msg.author || msg.from || null,
            body: body,
            type: msg.type,
            timestamp: msg.timestamp,
            jsonDump: JSON.stringify(meta),
        });
    } catch (err) {
        logger.error({ err }, 'Erro ao salvar mensagem de grupo (fallback)');
    }
});

app.set('waClient', client);

app.use('/', webRouter);

app.listen(PORT, () => {
    logger.info({ url: `http://localhost:${PORT}` }, 'Servidor web disponível');
});

client.initialize();