'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const { passport, isAllowedEmail } = require('./auth');
const dbMod = require('./db');
const { initSockets } = require('./sockets');
const fs = require('fs');

// Última linha de defesa: erro que escapa do ciclo do Express não pode
// derrubar o servidor da escola (ex.: lib de OAuth jogando exceção fora do request).
process.on('uncaughtException', (err) => {
  console.error('⚠️ Exceção não tratada (servidor mantido vivo):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Promise rejeitada sem handler:', reason?.message || reason);
});

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ------------------------------------------------------------ session

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'descola-perdizes-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }, // 30 dias
});

// Alguns navegadores/colas no console do Google grudam um \n no fim da
// redirect URI (vira /auth/google/callback%0A). Toleramos isso antes do roteamento.
app.use((req, res, next) => {
  if (req.url.includes('%0A')) {
    req.url = req.url.replace(/%0A/g, '');
    req.originalUrl = req.originalUrl.replace(/%0A/g, '');
  }
  next();
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Compartilha a sessão com o Socket.IO (mesmo cookie, mesma autenticação)
io.engine.use(sessionMiddleware);

// ------------------------------------------------------------ helpers

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'não-autenticado' });
  next();
}

function cleanContent(content) {
  return String(content || '').trim().slice(0, 4000);
}

// ----------------------------------------------------------- uploads

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    const allow = /^(image\/|text\/|application\/pdf|video\/)/;
    cb(null, allow.test(file.mimetype));
  },
});

// ------------------------------------------------------------ auth routes

app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account',
}));

app.get('/auth/google/callback', passport.authenticate('google', {
  successRedirect: '/',
  failureRedirect: '/?erro=login-negado',
}));

app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

// ⚠️ SÓ PARA TESTES (dev): login sem Google. Desligado em produção.
// Use: /auth/dev?email=fulano@alunopueri.com.br&name=Fulano
if (process.env.DEV_LOGIN === 'true' && process.env.NODE_ENV !== 'production') {
  app.get('/auth/dev', (req, res) => {
    const email = String(req.query.email || '').toLowerCase();
    if (!isAllowedEmail(email)) return res.redirect('/?erro=login-negado');
    const profile = {
      googleId: 'dev-' + email,
      displayName: String(req.query.name || email.split('@')[0]).slice(0, 60),
      emails: [{ value: email }],
      photos: [],
    };
    const user = dbMod.upsertUser(profile);
    req.login(user, (err) => (err ? res.status(500).send('erro') : res.redirect('/')));
  });
}

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json(null);
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email, avatar: req.user.avatar, role: req.user.role });
});

// --------------------------------------------------------- servers API

app.get('/api/servers', requireAuth, (req, res) => {
  const servers = dbMod.getServersForUser(req.user.id);
  res.json(servers);
});

app.post('/api/servers', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'nome-obrigatório' });
  const server = dbMod.createServer(name, String(req.body.icon || '').slice(0, 4) || null, req.user.id);
  res.json(server);
});

app.get('/api/servers/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!dbMod.isMember(id, req.user.id)) return res.status(403).json({ error: 'não-membro' });
  const server = dbMod.getServerFull(id);
  server.unread = dbMod.getUnreadCounts(req.user.id, id);
  res.json(server);
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const member = dbMod.getMember(id, req.user.id);
  if (!member) return res.status(403).json({ error: 'não-membro' });
  if (member.role !== 'dono' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'só-dono' });
  }
  dbMod.deleteServer(id);
  res.json({ ok: true });
});

app.post('/api/servers/join', requireAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const server = dbMod.getServerByInvite(code);
  if (!server) return res.status(404).json({ error: 'convite-inválido' });
  dbMod.addMember(server.id, req.user.id);
  res.json(dbMod.getServerFull(server.id));
});

// -------------------------------------------------------- channels API

app.post('/api/servers/:id/channels', requireAuth, (req, res) => {
  const serverId = Number(req.params.id);
  const member = dbMod.getMember(serverId, req.user.id);
  if (!member) return res.status(403).json({ error: 'não-membro' });
  if (member.role !== 'dono' && member.role !== 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'sem-permissão' });
  }
  const name = String(req.body.name || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 30);
  if (!name) return res.status(400).json({ error: 'nome-obrigatório' });
  const channel = dbMod.createChannel(serverId, name);
  io.to(`server:${serverId}`).emit('channel_created', { channel, serverId });
  res.json(channel);
});

app.delete('/api/channels/:id', requireAuth, (req, res) => {
  const channelId = Number(req.params.id);
  const channel = dbMod.getChannel(channelId);
  if (!channel) return res.status(404).json({ error: 'não-encontrado' });
  const member = dbMod.getMember(channel.server_id, req.user.id);
  if (!member) return res.status(403).json({ error: 'não-membro' });
  if (member.role !== 'dono' && member.role !== 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'sem-permissão' });
  }
  if (!dbMod.deleteChannel(channelId)) return res.status(400).json({ error: 'último-canal' });
  io.to(`server:${channel.server_id}`).emit('channel_deleted', { channelId, serverId: channel.server_id });
  res.json({ ok: true });
});

// --------------------------------------------------------- messages API

app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  const channelId = Number(req.params.id);
  const channel = dbMod.getChannel(channelId);
  if (!channel) return res.status(404).json({ error: 'não-encontrado' });
  if (!dbMod.isMember(channel.server_id, req.user.id)) return res.status(403).json({ error: 'não-membro' });
  const messages = dbMod.getChannelMessages(channelId);
  dbMod.attachReactions(messages, req.user.id);
  res.json(messages);
});

app.post('/api/channels/:id/upload', requireAuth, upload.single('file'), (req, res) => {
  const channelId = Number(req.params.id);
  const channel = dbMod.getChannel(channelId);
  if (!channel) return res.status(404).json({ error: 'não-encontrado' });
  if (!dbMod.isMember(channel.server_id, req.user.id)) return res.status(403).json({ error: 'não-membro' });
  if (!req.file) return res.status(400).json({ error: 'arquivo-inválido' });
  res.json({
    url: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    type: req.file.mimetype,
  });
});

// ------------------------------------------------------------- users API

app.get('/api/users/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(dbMod.searchUsers(q, req.user.id));
});

// -------------------------------------------------------------- DMs API

app.get('/api/dms', requireAuth, (req, res) => {
  res.json(dbMod.getDmChannelsForUser(req.user.id));
});

app.post('/api/dms', requireAuth, (req, res) => {
  const otherId = Number(req.body.userId);
  if (!otherId || otherId === req.user.id) return res.status(400).json({ error: 'inválido' });
  if (!dbMod.getUserById(otherId)) return res.status(404).json({ error: 'usuário-inexistente' });
  const dmId = dbMod.getOrCreateDm(req.user.id, otherId);
  const other = dbMod.getDmWithOther(dmId, req.user.id);
  res.json({ id: dmId, other });
});

app.get('/api/dm/:id/messages', requireAuth, (req, res) => {
  const dmId = Number(req.params.id);
  if (!dbMod.isDmMember(dmId, req.user.id)) return res.status(403).json({ error: 'não-membro' });
  res.json(dbMod.getDmMessages(dmId));
});

// ---------------------------------------------------------------- boot

// Erros que chegam ao fim do pipeline: fluxo de auth volta pro login; resto vira 500.
app.use((err, req, res, next) => {
  console.error('Erro na rota', req.path + ':', err.message);
  if (req.path.startsWith('/auth/')) return res.redirect('/?erro=login-negado');
  res.status(500).json({ error: 'erro-interno' });
});

initSockets(io, dbMod);

server.listen(PORT, () => {
  console.log(`🟢 Descola Perdizes rodando em ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`   Login restrito a @${process.env.ALLOWED_DOMAIN || 'alunopueri.com.br'}`);
});
