'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'descola.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id  TEXT UNIQUE NOT NULL,
  email      TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  avatar     TEXT,
  role       TEXT NOT NULL DEFAULT 'aluno',   -- aluno | admin
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS servers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  icon        TEXT,
  invite_code TEXT UNIQUE NOT NULL,
  owner_id    INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'membro',        -- dono | admin | membro
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dm_channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dm_members (
  dm_id   INTEGER NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  PRIMARY KEY (dm_id, user_id)
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dm_id      INTEGER NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_dm_messages_dm ON dm_messages(dm_id, id);

-- v2: reações, leitura de canais
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS channel_reads (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
`);

// Migração leve: garante colunas novas em messages (idempotente)
function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}
ensureColumn('messages', 'attachment_url', 'TEXT');
ensureColumn('messages', 'attachment_name', 'TEXT');
ensureColumn('messages', 'attachment_type', 'TEXT');

// ---------------------------------------------------------------- users

function upsertUser(profile) {
  const existing = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.googleId);
  if (existing) {
    db.prepare('UPDATE users SET name = ?, avatar = ? WHERE id = ?').run(
      profile.displayName, profile.photos?.[0]?.value || null, existing.id
    );
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  // Primeiro usuário da plataforma vira admin global (e dá pra adicionar mais via ADMIN_EMAILS)
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const role = c === 0 || admins.includes(profile.emails[0].value.toLowerCase()) ? 'admin' : 'aluno';
  const info = db.prepare(
    'INSERT INTO users (google_id, email, name, avatar, role) VALUES (?, ?, ?, ?, ?)'
  ).run(profile.googleId, profile.emails[0].value, profile.displayName, profile.photos?.[0]?.value || null, role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function searchUsers(query, excludeId, limit = 10) {
  const like = `%${query}%`;
  return db.prepare(
    `SELECT id, name, email, avatar, role FROM users
     WHERE id != ? AND (name LIKE ? OR email LIKE ?)
     ORDER BY name LIMIT ?`
  ).all(excludeId, like, like, limit);
}

// ------------------------------------------------------------- servers

function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!db.prepare('SELECT id FROM servers WHERE invite_code = ?').get(code)) return code;
  }
}

function createServer(name, icon, ownerId) {
  const serverId = db.transaction(() => {
    const info = db.prepare(
      'INSERT INTO servers (name, icon, invite_code, owner_id) VALUES (?, ?, ?, ?)'
    ).run(name, icon || null, genInviteCode(), ownerId);
    db.prepare('INSERT INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)')
      .run(info.lastInsertRowid, ownerId, 'dono');
    db.prepare('INSERT INTO channels (server_id, name) VALUES (?, ?)').run(info.lastInsertRowid, 'geral');
    return info.lastInsertRowid;
  })();
  return serverId ? getServerFull(serverId) : null;
}

function getServer(id) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}

function getServerByInvite(code) {
  return db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(code);
}

function getServerFull(serverId) {
  const server = getServer(serverId);
  if (!server) return null;
  server.channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY id').all(serverId);
  server.members = db.prepare(
    `SELECT u.id, u.name, u.email, u.avatar, u.role AS global_role, m.role AS server_role
     FROM server_members m JOIN users u ON u.id = m.user_id
     WHERE m.server_id = ? ORDER BY u.name`
  ).all(serverId);
  return server;
}

function getServersForUser(userId) {
  return db.prepare(
    `SELECT s.*, m.role AS my_role FROM servers s
     JOIN server_members m ON m.server_id = s.id
     WHERE m.user_id = ? ORDER BY s.name`
  ).all(userId);
}

function isMember(serverId, userId) {
  return !!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

function getMember(serverId, userId) {
  return db.prepare('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

function addMember(serverId, userId) {
  db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)')
    .run(serverId, userId, 'membro');
}

function deleteServer(serverId) {
  db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
}

// ------------------------------------------------------------ channels

function getChannel(id) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

function createChannel(serverId, name) {
  const info = db.prepare('INSERT INTO channels (server_id, name) VALUES (?, ?)').run(serverId, name);
  return getChannel(info.lastInsertRowid);
}

function deleteChannel(channelId) {
  const ch = getChannel(channelId);
  const n = db.prepare('SELECT COUNT(*) AS c FROM channels WHERE server_id = ?').get(ch.server_id).c;
  if (n <= 1) return false; // nunca apagar o último canal
  db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
  return true;
}

// ------------------------------------------------------------ messages

function insertMessage(channelId, userId, content, attachment = null) {
  const info = db.prepare(
    `INSERT INTO messages (channel_id, user_id, content, attachment_url, attachment_name, attachment_type)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(channelId, userId, content, attachment?.url || null, attachment?.name || null, attachment?.type || null);
  return getMessage(info.lastInsertRowid);
}

function getMessage(id) {
  return db.prepare(
    `SELECT m.id, m.channel_id, m.content, m.created_at, m.attachment_url, m.attachment_name, m.attachment_type,
            u.id AS user_id, u.name AS user_name, u.avatar AS user_avatar, u.role AS user_role
     FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`
  ).get(id);
}

function getChannelMessages(channelId, limit = 100) {
  return db.prepare(
    `SELECT m.id, m.channel_id, m.content, m.created_at, m.attachment_url, m.attachment_name, m.attachment_type,
            u.id AS user_id, u.name AS user_name, u.avatar AS user_avatar, u.role AS user_role
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`
  ).all(channelId, limit).reverse();
}

// ------------------------------------------------------------ reactions

function toggleReaction(messageId, userId, emoji) {
  const existing = db.prepare(
    'SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
  ).get(messageId, userId, emoji);
  if (existing) {
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .run(messageId, userId, emoji);
    return false;
  }
  db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)')
    .run(messageId, userId, emoji);
  return true;
}

function getReactions(messageId, userId) {
  return db.prepare(
    `SELECT emoji, COUNT(*) AS count,
            MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me
     FROM reactions WHERE message_id = ? GROUP BY emoji ORDER BY count DESC`
  ).all(userId, messageId);
}

// Anexa reações em lote às mensagens (evita N queries)
function attachReactions(messages, userId) {
  if (!messages.length) return messages;
  const ids = messages.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT message_id, emoji, COUNT(*) AS count,
            MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me
     FROM reactions WHERE message_id IN (${placeholders})
     GROUP BY message_id, emoji`
  ).all(userId, ...ids);
  const byMsg = {};
  for (const r of rows) (byMsg[r.message_id] = byMsg[r.message_id] || []).push(r);
  for (const m of messages) m.reactions = byMsg[m.id] || [];
  return messages;
}

// -------------------------------------------------------------- unread

function getUnreadCounts(userId, serverId) {
  const channels = db.prepare('SELECT id FROM channels WHERE server_id = ?').all(serverId);
  const counts = {};
  const q = db.prepare(
    `SELECT COUNT(*) AS c FROM messages
     WHERE channel_id = ? AND id > COALESCE(
       (SELECT last_read FROM channel_reads WHERE user_id = ? AND channel_id = ?), 0)`
  );
  for (const ch of channels) counts[ch.id] = q.get(ch.id, userId, ch.id).c;
  return counts;
}

function markChannelRead(userId, channelId) {
  db.prepare(
    `INSERT INTO channel_reads (user_id, channel_id, last_read)
     VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ?))
     ON CONFLICT(user_id, channel_id)
     DO UPDATE SET last_read = excluded.last_read, updated_at = datetime('now')`
  ).run(userId, channelId, channelId);
}

// ------------------------------------------------------------------ dms

function getOrCreateDm(userA, userB) {
  if (userA === userB) return null;
  const existing = db.prepare(
    `SELECT d.id FROM dm_channels d
     JOIN dm_members a ON a.dm_id = d.id AND a.user_id = ?
     JOIN dm_members b ON b.dm_id = d.id AND b.user_id = ?
     LIMIT 1`
  ).get(userA, userB);
  if (existing) return existing.id;
  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO dm_channels DEFAULT VALUES').run();
    db.prepare('INSERT INTO dm_members (dm_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, userA);
    db.prepare('INSERT INTO dm_members (dm_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, userB);
    return info.lastInsertRowid;
  });
  return tx();
}

function getDmChannelsForUser(userId) {
  const rows = db.prepare(
    `SELECT d.id, u.id AS other_id, u.name AS other_name, u.avatar AS other_avatar,
            (SELECT content FROM dm_messages x WHERE x.dm_id = d.id ORDER BY x.id DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM dm_messages x WHERE x.dm_id = d.id ORDER BY x.id DESC LIMIT 1) AS last_at
     FROM dm_channels d
     JOIN dm_members me ON me.dm_id = d.id AND me.user_id = ?
     JOIN dm_members mo ON mo.dm_id = d.id AND mo.user_id != ?
     JOIN users u ON u.id = mo.user_id
     ORDER BY COALESCE(last_at, d.created_at) DESC`
  ).all(userId, userId);
  return rows;
}

function isDmMember(dmId, userId) {
  return !!db.prepare('SELECT 1 FROM dm_members WHERE dm_id = ? AND user_id = ?').get(dmId, userId);
}

function getDmWithOther(dmId, userId) {
  return db.prepare(
    `SELECT u.id, u.name, u.avatar, u.email FROM dm_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.dm_id = ? AND m.user_id != ?`
  ).get(dmId, userId);
}

function insertDmMessage(dmId, userId, content) {
  const info = db.prepare(
    'INSERT INTO dm_messages (dm_id, user_id, content) VALUES (?, ?, ?)'
  ).run(dmId, userId, content);
  return getDmMessage(info.lastInsertRowid);
}

function getDmMessage(id) {
  return db.prepare(
    `SELECT m.id, m.dm_id, m.content, m.created_at, u.id AS user_id, u.name AS user_name,
            u.avatar AS user_avatar
     FROM dm_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`
  ).get(id);
}

function getDmMessages(dmId, limit = 100) {
  return db.prepare(
    `SELECT m.id, m.dm_id, m.content, m.created_at, u.id AS user_id, u.name AS user_name,
            u.avatar AS user_avatar
     FROM dm_messages m JOIN users u ON u.id = m.user_id
     WHERE m.dm_id = ? ORDER BY m.id DESC LIMIT ?`
  ).all(dmId, limit).reverse();
}

module.exports = {
  db,
  upsertUser,
  getUserById,
  searchUsers,
  createServer,
  getServer,
  getServerByInvite,
  getServerFull,
  getServersForUser,
  isMember,
  getMember,
  addMember,
  deleteServer,
  getChannel,
  createChannel,
  deleteChannel,
  insertMessage,
  getMessage,
  getChannelMessages,
  toggleReaction,
  getReactions,
  attachReactions,
  getUnreadCounts,
  markChannelRead,
  getOrCreateDm,
  getDmChannelsForUser,
  isDmMember,
  getDmWithOther,
  insertDmMessage,
  getDmMessage,
  getDmMessages,
};
