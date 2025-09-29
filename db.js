const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const DB_CLIENT = (process.env.DB_CLIENT || 'sqlite').toLowerCase();

function nowIso() {
    return new Date().toISOString();
}

let db = null;
let pool = null;

if (DB_CLIENT === 'postgres' || DB_CLIENT === 'postgresql') {
    // Configuração PostgreSQL via variáveis de ambiente padrão do driver pg
    pool = new Pool({
        host: process.env.PGHOST,
        port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
        max: process.env.PGPOOL_MAX ? Number(process.env.PGPOOL_MAX) : 10,
    });

    // Migrações básicas (PostgreSQL)
    (async () => {
        const client = await pool.connect();
        try {
            await client.query(`
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);
`);
            await client.query(`
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    user_id TEXT,
    body TEXT,
    type TEXT,
    timestamp BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    json_dump TEXT
);
`);
            await client.query(`
CREATE TABLE IF NOT EXISTS history_info_groups (
    id SERIAL PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT,
    users_count INTEGER,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);
`);
        } finally {
            client.release();
        }
    })().catch(() => {});
} else {
    // SQLite (padrão)
    const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    // Migrações básicas
    db.exec(`
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);
`);

    db.exec(`
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    user_id TEXT,
    body TEXT,
    type TEXT,
    timestamp INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);
`);

    // Add column json_dump if not exists
    const pragmaMessages = db.prepare("PRAGMA table_info(messages)").all();
    const hasJsonDump = pragmaMessages.some(c => c.name === 'json_dump');
    if (!hasJsonDump) {
        db.exec(`ALTER TABLE messages ADD COLUMN json_dump TEXT`);
    }

    // Se a tabela messages possuir FKs, recriar sem FKs preservando dados
    const fkList = db.prepare('PRAGMA foreign_key_list(messages)').all();
    if (fkList && fkList.length > 0) {
        try {
            db.pragma('foreign_keys = OFF');
            db.exec(`
CREATE TABLE IF NOT EXISTS __messages_new (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    user_id TEXT,
    body TEXT,
    type TEXT,
    timestamp INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    json_dump TEXT
);
INSERT OR IGNORE INTO __messages_new (id, group_id, user_id, body, type, timestamp, created_at, updated_at, deleted_at, json_dump)
SELECT id, group_id, user_id, body, type, timestamp, created_at, updated_at, deleted_at, json_dump FROM messages;
DROP TABLE messages;
ALTER TABLE __messages_new RENAME TO messages;
`);
        } finally {
            db.pragma('foreign_keys = ON');
        }
    }

    // 3) Criar tabela de histórico
    db.exec(`
CREATE TABLE IF NOT EXISTS history_info_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    name TEXT,
    users_count INTEGER,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);
`);

    // 4) Remover tabelas antigas (não usadas)
    try {
        db.pragma('foreign_keys = OFF');
        db.exec(`
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS users;
`);
    } finally {
        db.pragma('foreign_keys = ON');
    }
}

// Upserts e inserts essenciais
function upsertGroup(group) {
    const now = nowIso();
    if (pool) {
        pool.query(
            `INSERT INTO groups (id, name, created_at, updated_at)
             VALUES ($1, $2, $3, $3)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
            [group.id, group.name, now]
        ).catch(() => {});
        return;
    }
    const upsertGroupStmt = db.prepare(`
INSERT INTO groups (id, name, created_at, updated_at)
VALUES (@id, @name, @now, @now)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  updated_at = excluded.updated_at
`);
    upsertGroupStmt.run({ id: group.id, name: group.name, now });
}

function insertGroupMessage(msg) {
    const now = nowIso();
    if (pool) {
        pool.query(
            `INSERT INTO messages (id, group_id, user_id, body, type, timestamp, created_at, updated_at, json_dump)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
             ON CONFLICT (id) DO NOTHING`,
            [
                msg.id,
                msg.groupId,
                msg.userId || null,
                msg.body || null,
                msg.type || null,
                msg.timestamp || null,
                now,
                msg.jsonDump || null,
            ]
        ).catch(() => {});
        return;
    }
    const insertMessageStmt = db.prepare(`
INSERT OR IGNORE INTO messages (id, group_id, user_id, body, type, timestamp, created_at, updated_at, json_dump)
VALUES (@id, @group_id, @user_id, @body, @type, @timestamp, @now, @now, @json_dump)
`);
    insertMessageStmt.run({
        id: msg.id,
        group_id: msg.groupId,
        user_id: msg.userId || null,
        body: msg.body || null,
        type: msg.type || null,
        timestamp: msg.timestamp || null,
        now,
        json_dump: msg.jsonDump || null,
    });
}

function insertGroupHistory(snapshot) {
    const now = nowIso();
    if (pool) {
        pool.query(
            `INSERT INTO history_info_groups (group_id, name, users_count, description, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $5)`,
            [snapshot.groupId, snapshot.name || null, typeof snapshot.usersCount === 'number' ? snapshot.usersCount : null, snapshot.description || null, now]
        ).catch(() => {});
        return;
    }
    const insertGroupHistoryStmt = db.prepare(`
INSERT INTO history_info_groups (group_id, name, users_count, description, created_at, updated_at)
VALUES (@group_id, @name, @users_count, @description, @now, @now)
`);
    insertGroupHistoryStmt.run({
        group_id: snapshot.groupId,
        name: snapshot.name || null,
        users_count: typeof snapshot.usersCount === 'number' ? snapshot.usersCount : null,
        description: snapshot.description || null,
        now,
    });
}

async function insertGroupHistoryIfChanged(snapshot) {
    const name = snapshot.name || null;
    const usersCount = typeof snapshot.usersCount === 'number' ? snapshot.usersCount : null;
    const description = snapshot.description || null;
    if (pool) {
        const res = await pool.query(
            `SELECT id, group_id, name, users_count, description, created_at, updated_at, deleted_at
             FROM history_info_groups
             WHERE group_id = $1
             ORDER BY id DESC
             LIMIT 1`,
            [snapshot.groupId]
        );
        const last = res.rows[0];
        const changed = !last || last.name !== name || last.users_count !== usersCount || last.description !== description;
        if (changed) {
            await pool.query(
                `INSERT INTO history_info_groups (group_id, name, users_count, description, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $5)`,
                [snapshot.groupId, name, usersCount, description, nowIso()]
            );
            return true;
        }
        return false;
    }
    const getLastGroupHistoryStmt = db.prepare(`
SELECT id, group_id, name, users_count, description, created_at, updated_at, deleted_at
FROM history_info_groups
WHERE group_id = ?
ORDER BY id DESC
LIMIT 1
`);
    const last = getLastGroupHistoryStmt.get(snapshot.groupId);
    const changed = !last || last.name !== name || last.users_count !== usersCount || last.description !== description;
    if (changed) {
        insertGroupHistory({ groupId: snapshot.groupId, name, usersCount, description });
        return true;
    }
    return false;
}

module.exports = {
    db,
    upsertGroup,
    insertGroupMessage,
    insertGroupHistory,
    insertGroupHistoryIfChanged,
}; 