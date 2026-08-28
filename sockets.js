'use strict';

function cleanContent(content) {
  return String(content || '').trim().slice(0, 4000);
}

// Usuários conectados (para presença): userId -> Set<socketId>
const onlineUsers = new Map();

function broadcastPresence(io) {
  io.emit('presence', { onlineIds: [...onlineUsers.keys()] });
}

function initSockets(io, db) {
  // Um erro num handler não pode derrubar o servidor da escola inteira
  const safe = (fn) => (...args) => {
    try { fn(...args); } catch (err) { console.error('Erro em evento de socket:', err.message); }
  };

  io.on('connection', (socket) => {
    try {
      handleConnection(io, db, socket, safe);
    } catch (err) {
      console.error('Erro na conexão do socket:', err.message);
      socket.disconnect(true);
    }
  });
}

function handleConnection(io, db, socket, safe) {
  // Sessão compartilhada com o Express — quem está logado no site está logado no socket
  const userId = socket.request.session?.passport?.user;
  const user = userId ? db.getUserById(userId) : null;
  if (!user) {
    socket.disconnect(true);
    return;
  }
  socket.user = user;

  // Presença: marca online e avisa todo mundo
  if (!onlineUsers.has(user.id)) onlineUsers.set(user.id, new Set());
  onlineUsers.get(user.id).add(socket.id);
  broadcastPresence(io);

  // Entra nas salas dos servidores/DMs que o usuário já pertence
  for (const s of db.getServersForUser(user.id)) socket.join(`server:${s.id}`);
  for (const d of db.getDmChannelsForUser(user.id)) socket.join(`dm:${d.id}`);

  socket.on('disconnect', () => {
    const set = onlineUsers.get(user.id);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(user.id);
        broadcastPresence(io);
      }
    }
  });

  socket.on('join_server', safe((serverId) => {
    if (db.isMember(Number(serverId), user.id)) socket.join(`server:${serverId}`);
  }));

  socket.on('join_dm', safe((dmId) => {
    if (db.isDmMember(Number(dmId), user.id)) socket.join(`dm:${dmId}`);
  }));

  // ------------------------------------------------ mensagens de canal

  socket.on('send_message', safe(({ channelId, content, attachment }) => {
    const text = cleanContent(content);
    if (!text && !attachment) return;
    const channel = db.getChannel(Number(channelId));
    if (!channel) return;
    if (!db.isMember(channel.server_id, user.id)) return;

    // Anexo: só aceita arquivos que a gente mesmo serviu (nada de URL arbitrária)
    let att = null;
    if (attachment) {
      const url = String(attachment.url || '');
      if (!url.startsWith('/uploads/')) return;
      att = {
        url: url.slice(0, 300),
        name: String(attachment.name || 'arquivo').slice(0, 120),
        type: String(attachment.type || '').slice(0, 100),
      };
    }

    const msg = db.insertMessage(channel.id, user.id, text, att);
    msg.reactions = [];

    // Menções: avisa o coleguinha mencionado (se estiver online)
    if (text) {
      const members = db.getServerFull(channel.server_id).members;
      for (const m of members) {
        if (m.id === user.id) continue;
        const pattern = new RegExp('(^|\\s)@?' + escapeRegExp(m.name) + '(?=$|\\s|[.,!?;:])', 'i');
        if (pattern.test(text)) {
          for (const sid of onlineUsers.get(m.id) || []) {
            io.to(sid).emit('mention', {
              from: user.name,
              channelId: channel.id,
              channelName: channel.name,
              serverId: channel.server_id,
            });
          }
        }
      }
    }

    io.to(`server:${channel.server_id}`).emit('new_message', msg);
  }));

  socket.on('typing', safe(({ channelId }) => {
    const channel = db.getChannel(Number(channelId));
    if (!channel || !db.isMember(channel.server_id, user.id)) return;
    socket.to(`server:${channel.server_id}`).emit('typing', {
      channelId: channel.id, userName: user.name, userId: user.id,
    });
  }));

  // ------------------------------------------------- reações

  socket.on('add_reaction', safe(({ messageId, emoji }) => {
    const e = String(emoji || '').trim().slice(0, 16);
    const mid = Number(messageId);
    if (!e || !mid) return;
    const msg = db.getMessage(mid);
    if (!msg) return;
    const channel = db.getChannel(msg.channel_id);
    if (!channel || !db.isMember(channel.server_id, user.id)) return;
    const added = db.toggleReaction(mid, user.id, e);
    io.to(`server:${channel.server_id}`).emit('reaction_update', {
      messageId: mid, emoji: e, userId: user.id, added,
    });
  }));

  socket.on('remove_reaction', safe(({ messageId, emoji }) => {
    const e = String(emoji || '').trim().slice(0, 16);
    const mid = Number(messageId);
    if (!e || !mid) return;
    const msg = db.getMessage(mid);
    if (!msg) return;
    const channel = db.getChannel(msg.channel_id);
    if (!channel || !db.isMember(channel.server_id, user.id)) return;
    const added = db.toggleReaction(mid, user.id, e);
    io.to(`server:${channel.server_id}`).emit('reaction_update', {
      messageId: mid, emoji: e, userId: user.id, added,
    });
  }));

  // --------------------------------------------- marcação de leitura

  socket.on('mark_read', safe(({ channelId }) => {
    const channel = db.getChannel(Number(channelId));
    if (!channel || !db.isMember(channel.server_id, user.id)) return;
    db.markChannelRead(user.id, channel.id);
  }));

  // ----------------------------------------------------- mensagens de DM

  socket.on('send_dm', safe(({ dmId, content }) => {
    const text = cleanContent(content);
    if (!text) return;
    if (!db.isDmMember(Number(dmId), user.id)) return;
    const msg = db.insertDmMessage(Number(dmId), user.id, text);
    io.to(`dm:${dmId}`).emit('new_dm_message', msg);
  }));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { initSockets };
