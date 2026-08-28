'use strict';

/* ================================================================
   Descola Perdizes — frontend v2 (RTechLabs)
   Presença online, reações, menções @, não-lidas, imagens/arquivos
   ================================================================ */

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function initialOf(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function avatarHtml(user, cls, size) {
  if (user.avatar) return `<img class="${cls}" src="${esc(user.avatar)}" alt="" referrerpolicy="no-referrer" />`;
  return `<div class="${cls}" style="background:#5865f2;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:${size || 14}px;width:100%;height:100%;">${esc(initialOf(user.name))}</div>`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `hoje ${time}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `ontem ${time}`;
  return d.toLocaleDateString('pt-BR') + ' ' + time;
}

function badgeHtml(role) {
  if (role === 'dono') return `<span class="msg-badge badge-dono">Dono</span>`;
  if (role === 'admin') return `<span class="msg-badge badge-admin">Admin</span>`;
  return '';
}

function escReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ================================================================ ESTADO */

const S = {
  me: null,
  socket: null,
  view: 'home',          // 'home' | 'server'
  servers: [],
  server: null,
  channel: null,
  dms: [],
  dm: null,
  online: new Set(),     // ids de usuários online (presença)
  unread: {},            // channelId -> qtd não-lida
  chatMessages: new Map(), // id -> msg (para reações em tempo real)
  typing: {},
};

/* ================================================================ API */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'erro');
  }
  return res.json();
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

/* ================================================================ BOOT */

async function boot() {
  if (new URLSearchParams(location.search).get('erro') === 'login-negado') {
    $('#login-error').classList.remove('hidden');
  }

  let me = null;
  try { me = await api('/api/me'); } catch (e) { /* servidor fora do ar */ }

  if (!me) { showLogin(); return; }

  S.me = me;
  initSocket();
  await refreshServers();
  await refreshDms();
  showApp();
  openHome();
}

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  document.body.style.background = '#1e1f22';
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#btn-user').innerHTML = avatarHtml(S.me, 'initial', 14);
}

function initSocket() {
  S.socket = io();
  S.socket.on('connect_error', () => toast('Sem conexão com o servidor…', true));
  S.socket.on('disconnect', () => toast('Conexão perdida, reconectando…', true));

  S.socket.on('presence', ({ onlineIds }) => {
    S.online = new Set(onlineIds);
    renderMembers();
    renderDmList();
  });

  S.socket.on('new_message', (msg) => {
    S.chatMessages.set(msg.id, msg);
    if (S.view === 'server' && S.channel && msg.channel_id === S.channel.id) {
      appendMessage(msg);
      S.socket.emit('mark_read', { channelId: msg.channel_id });
    } else {
      S.unread[msg.channel_id] = (S.unread[msg.channel_id] || 0) + 1;
      if (S.view === 'server' && S.server && S.server.channels.some(c => c.id === msg.channel_id)) {
        renderChannels();
      }
    }
  });

  S.socket.on('new_dm_message', (msg) => {
    if (S.view === 'home' && S.dm && msg.dm_id === S.dm.id) appendMessage(msg);
    refreshDms();
  });

  S.socket.on('mention', ({ from, channelId, channelName }) => {
    toast(`🔔 ${from} te mencionou em #${channelName}`);
    if (S.view === 'server' && S.server) {
      S.unread[channelId] = (S.unread[channelId] || 0) + 1;
      renderChannels();
    }
  });

  S.socket.on('reaction_update', ({ messageId, emoji, userId, added }) => {
    const msg = S.chatMessages.get(messageId);
    if (!msg) return;
    msg.reactions = msg.reactions || [];
    const found = msg.reactions.find(r => r.emoji === emoji);
    const isMe = userId === S.me.id;
    if (added) {
      if (found) { found.count++; if (isMe) found.me = 1; }
      else msg.reactions.push({ emoji, count: 1, me: isMe ? 1 : 0 });
    } else {
      if (found) {
        found.count--; if (isMe) found.me = 0;
        if (found.count <= 0) msg.reactions = msg.reactions.filter(r => r !== found);
      }
    }
    updateReactionsDom(messageId, msg.reactions);
  });

  S.socket.on('typing', ({ channelId, userName, userId }) => {
    if (S.view === 'server' && S.channel && channelId === S.channel.id && userId !== S.me.id) {
      showTyping(userName);
    }
  });

  S.socket.on('channel_created', ({ channel, serverId }) => {
    if (S.view === 'server' && S.server && S.server.id === serverId) {
      S.server.channels.push(channel);
      renderChannels();
    }
  });

  S.socket.on('channel_deleted', ({ channelId, serverId }) => {
    if (S.view === 'server' && S.server && S.server.id === serverId) {
      S.server.channels = S.server.channels.filter(c => c.id !== channelId);
      if (S.channel && S.channel.id === channelId) {
        S.channel = S.server.channels[0] || null;
        openChannel(S.channel);
      } else {
        renderChannels();
      }
    }
  });
}

/* ================================================================ LOAD */

async function refreshServers() {
  S.servers = await api('/api/servers');
  renderRail();
}

async function refreshDms() {
  S.dms = await api('/api/dms');
  if (S.view === 'home') renderDmList();
}

/* ================================================================ NAVEGAÇÃO */

function openHome() {
  S.view = 'home';
  S.server = null;
  S.channel = null;
  S.dm = S.dms[0] || null;

  renderRail();
  renderSidebar();
  renderMembers();

  $('#chat-header').innerHTML = `
    <span class="hash">💬</span> Mensagens diretas
    <span class="sub">— converse com qualquer aluno</span>`;
  $('#msg-input').placeholder = 'Mensagem para um aluno…';

  if (S.dm) openDm(S.dm.id);
  else {
    $('#messages').innerHTML = `<div class="empty-state"><div class="big">👋</div>Bem-vindo(a), ${esc(S.me.name.split(' ')[0])}!<br>Clique em <strong>＋</strong> ou em <strong>Nova conversa</strong> para chamar alguém da escola.</div>`;
    $('#members-panel').innerHTML = '';
  }
}

async function openServer(id) {
  const server = await api(`/api/servers/${id}`);
  S.view = 'server';
  S.server = server;
  S.channel = null;
  S.unread = { ...(server.unread || {}) };
  S.socket.emit('join_server', server.id);

  renderRail();
  renderSidebar();
  renderMembers();
  renderChatHeader();

  if (server.channels.length) openChannel(server.channels[0]);
  else $('#messages').innerHTML = `<div class="empty-state">Sem canais ainda.</div>`;
}

async function openChannel(channel) {
  if (!channel) return;
  S.channel = channel;
  S.chatMessages.clear();
  renderChannels();
  renderChatHeader();
  $('#msg-input').placeholder = `Mensagem para #${channel.name}`;
  S.socket.emit('mark_read', { channelId: channel.id });
  const msgs = await api(`/api/channels/${channel.id}/messages`);
  msgs.forEach(m => S.chatMessages.set(m.id, m));
  $('#messages').innerHTML = '';
  msgs.forEach(appendMessage);
  scrollToBottom();
}

async function openDm(dmId) {
  const dm = S.dms.find(d => d.id === dmId);
  if (!dm) return;
  S.dm = dm;
  renderDmList();
  $('#chat-header').innerHTML = `
    <span class="hash">💬</span> ${esc(dm.other_name)}
    <span class="sub">— mensagens diretas</span>`;
  $('#msg-input').placeholder = `Mensagem para ${dm.other_name.split(' ')[0]}…`;
  const msgs = await api(`/api/dm/${dmId}/messages`);
  $('#messages').innerHTML = '';
  msgs.forEach(appendMessage);
  scrollToBottom();
}

function renderChatHeader() {
  if (S.view !== 'server' || !S.server) return;
  $('#chat-header').innerHTML = `
    <span class="hash">#</span> ${S.channel ? esc(S.channel.name) : ''}
    <span class="sub">${esc(S.server.name)}</span>`;
}

/* ================================================================ RENDER: trilho */

function renderRail() {
  const rail = $('#server-rail');
  rail.innerHTML = '';
  $('#btn-home').classList.toggle('active', S.view === 'home');

  for (const s of S.servers) {
    const btn = document.createElement('button');
    btn.className = 'server-icon' + (S.view === 'server' && S.server && S.server.id === s.id ? ' active' : '');
    btn.title = s.name;
    btn.innerHTML = s.icon ? esc(s.icon) : `<span class="initial">${esc(initialOf(s.name))}</span>`;
    btn.onclick = () => openServer(s.id);
    rail.appendChild(btn);
  }
}

/* ================================================================ RENDER: sidebar */

function renderSidebar() {
  if (S.view === 'home') {
    $('#sidebar-header').innerHTML = `
      <span>Mensagens diretas</span>
      <div class="header-actions">
        <button id="btn-new-dm" title="Nova conversa">＋</button>
      </div>`;
    $('#sidebar-body').innerHTML = '';
    renderDmList();
    $('#sidebar-footer').innerHTML = userBox();
    $('#btn-new-dm').onclick = openNewDmModal;
    return;
  }

  const s = S.server;
  const canManage = s.my_role === 'dono' || s.my_role === 'admin' || S.me.role === 'admin';

  $('#sidebar-header').innerHTML = `
    <span title="${esc(s.name)}">${esc(s.name.slice(0, 18))}${s.name.length > 18 ? '…' : ''}</span>
    <div class="header-actions">
      <button id="btn-invite" title="Convidar">🔗</button>
      <button id="btn-settings" title="Opções">⋯</button>
    </div>`;
  $('#sidebar-body').innerHTML = `
    <div class="section-label">Canais de texto</div>
    <div id="channel-list"></div>
    ${canManage ? `<div class="channel-row" id="btn-add-channel" style="color:var(--text-muted)"><span class="hash" style="font-size:16px">＋</span><span class="name" style="font-size:13px">Adicionar canal</span></div>` : ''}`;
  $('#sidebar-footer').innerHTML = userBox();

  renderChannels();

  $('#btn-invite').onclick = openInviteModal;
  $('#btn-settings').onclick = openServerMenu;
  const add = $('#btn-add-channel');
  if (add) add.onclick = openCreateChannelModal;
}

function renderChannels() {
  const list = $('#channel-list');
  if (!list) return;
  list.innerHTML = '';
  for (const ch of S.server.channels) {
    const unread = S.unread[ch.id] || 0;
    const row = document.createElement('div');
    row.className = 'channel-row' + (S.channel && S.channel.id === ch.id ? ' active' : '');
    row.innerHTML = `<span class="hash">#</span><span class="name">${esc(ch.name)}</span>
      ${unread > 0 ? `<span class="unread-badge">${unread}</span>` : ''}`;
    row.onclick = () => openChannel(ch);
    if (S.server.my_role === 'dono' || S.server.my_role === 'admin' || S.me.role === 'admin') {
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); deleteChannel(ch); };
      row.appendChild(del);
    }
    list.appendChild(row);
  }
}

function renderDmList() {
  const body = $('#sidebar-body');
  if (!body) return;
  if (S.view !== 'home') return;

  let html = `<div class="channel-row" id="btn-new-dm-side" style="margin-bottom:8px"><span class="hash" style="font-size:14px">＋</span><span class="name">Nova conversa</span></div>`;
  html += `<div class="section-label">Mensagens</div>`;
  if (!S.dms.length) {
    html += `<div style="padding:8px;font-size:13px;color:var(--text-muted)">Nada ainda. Chama alguém! 👋</div>`;
  }
  for (const dm of S.dms) {
    const active = S.dm && S.dm.id === dm.id ? ' active' : '';
    const isOnline = S.online.has(dm.other_id);
    const last = dm.last_message ? `<div style="font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(dm.last_message.slice(0, 40))}</div>` : '';
    html += `
      <div class="dm-row${active}" data-dm="${dm.id}">
        <div class="dm-avatar">${avatarHtml({ name: dm.other_name, avatar: dm.other_avatar }, 'dm-avatar', 13)}${isOnline ? '<span class="dot"></span>' : ''}</div>
        <div style="min-width:0;flex:1">
          <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(dm.other_name)}</div>
          ${last}
        </div>
      </div>`;
  }
  body.innerHTML = html;

  body.querySelectorAll('.dm-row').forEach(el => {
    el.onclick = () => openDm(Number(el.dataset.dm));
  });
  const newDm = $('#btn-new-dm-side');
  if (newDm) newDm.onclick = openNewDmModal;
}

function userBox() {
  return `
    <div class="user-box" id="btn-user-box">
      <div class="dm-avatar">${avatarHtml(S.me, 'dm-avatar', 13)}</div>
      <div style="min-width:0">
        <div class="uname" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(S.me.name)}</div>
        <div class="utag">${S.me.role === 'admin' ? '🛡 admin' : esc(S.me.email)}</div>
      </div>
    </div>`;
}

/* ================================================================ RENDER: membros */

function renderMembers() {
  const panel = $('#members-panel');
  if (S.view !== 'server' || !S.server) {
    panel.innerHTML = '';
    return;
  }
  const roles = { dono: '👑', admin: '🛡️' };
  panel.innerHTML = `<div class="section-label">Membros — ${S.server.members.length} · ${S.server.members.filter(m => S.online.has(m.id)).length} online</div>` +
    S.server.members.map(m => `
      <div class="member-row" title="${esc(m.email)}">
        <div class="dm-avatar">${avatarHtml(m, 'dm-avatar', 12)}${S.online.has(m.id) ? '<span class="dot"></span>' : ''}</div>
        <span class="member-name${m.id === S.me.id ? ' you' : ''}">${roles[m.server_role] ? roles[m.server_role] + ' ' : ''}${esc(m.name)}${m.id === S.me.id ? ' (você)' : ''}</span>
      </div>`).join('');
}

/* ================================================================ RENDER: mensagens */

function renderText(text, memberNames) {
  let html = esc(text);
  for (const raw of memberNames) {
    const n = esc(raw);
    if (!n) continue;
    const re = new RegExp('(^|\\s)@?' + escReg(n) + '(?=$|\\s|[.,!?;:!])', 'gi');
    html = html.replace(re, (m, p1) => p1 + '<span class="mention">@' + n + '</span>');
  }
  return html;
}

function attachmentHtml(msg) {
  if (!msg.attachment_url) return '';
  if (msg.attachment_type && msg.attachment_type.startsWith('image/')) {
    return `<div class="msg-attach"><img class="msg-img" src="${esc(msg.attachment_url)}" alt="${esc(msg.attachment_name || 'imagem')}" loading="lazy" onclick="window.open(this.src)"/></div>`;
  }
  return `<div class="msg-attach"><a class="file-chip" href="${esc(msg.attachment_url)}" download="${esc(msg.attachment_name || 'arquivo')}">📄 ${esc(msg.attachment_name || 'arquivo')}</a></div>`;
}

function reactionsHtml(msg) {
  if (!msg.reactions || !msg.reactions.length) return '';
  return `<div class="msg-reactions">` + msg.reactions.map(r =>
    `<button class="reaction-btn${r.me ? ' me' : ''}" data-mid="${msg.id}" data-emoji="${esc(r.emoji)}">${esc(r.emoji)} ${r.count}</button>`
  ).join('') + `</div>`;
}

function appendMessage(msg) {
  const box = $('#messages');
  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.mid = msg.id;

  const names = S.view === 'server' && S.server
    ? S.server.members.map(m => m.name)
    : [msg.user_name];

  el.innerHTML = `
    <div class="msg-avatar">${avatarHtml({ name: msg.user_name, avatar: msg.user_avatar }, 'msg-avatar', 16)}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name">${esc(msg.user_name)}</span>
        ${badgeHtml(msg.user_role === 'admin' ? 'admin' : 'aluno')}
        <span class="msg-time">${fmtTime(msg.created_at)}</span>
      </div>
      ${msg.content ? `<div class="msg-text">${renderText(msg.content, names)}</div>` : ''}
      ${attachmentHtml(msg)}
      <div class="msg-reactions">${reactionsHtml(msg)}</div>
    </div>`;

  box.appendChild(el);
  scrollToBottom();
}

function updateReactionsDom(messageId, reactions) {
  const el = document.querySelector(`.msg[data-mid="${messageId}"] .msg-reactions`);
  if (!el) return;
  el.innerHTML = reactionsHtml({ id: messageId, reactions });
}

/* Clique em reação: toggle */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.reaction-btn');
  if (!btn) return;
  const mid = Number(btn.dataset.mid);
  const emoji = btn.dataset.emoji;
  const msg = S.chatMessages.get(mid);
  const already = msg && msg.reactions && msg.reactions.find(r => r.emoji === emoji && r.me);
  S.socket.emit(already ? 'remove_reaction' : 'add_reaction', { messageId: mid, emoji });
});

let nearBottom = true;
function scrollToBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}
$('#messages').addEventListener('scroll', () => {
  const box = $('#messages');
  nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
});

/* ================================================================ DIGITAÇÃO */

let typingTimer = null;
$('#msg-input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px';
  if (!typingTimer && S.socket && S.socket.connected) {
    if (S.view === 'server' && S.channel) S.socket.emit('typing', { channelId: S.channel.id });
    typingTimer = setTimeout(() => typingTimer = null, 2500);
  }
});

let typingT = null;
function showTyping(name) {
  $('#typing-bar').textContent = `${name} está digitando…`;
  clearTimeout(typingT);
  typingT = setTimeout(() => $('#typing-bar').textContent = '', 3000);
}

/* ================================================================ ENVIO */

$('#msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$('#btn-send').onclick = sendMessage;

function sendMessage(attachment) {
  const input = $('#msg-input');
  const content = input.value.trim();
  if ((!content && !attachment) || !S.socket || !S.socket.connected) return;
  if (S.view === 'server' && S.channel) {
    S.socket.emit('send_message', { channelId: S.channel.id, content, attachment });
  } else if (S.view === 'home' && S.dm) {
    if (attachment) return toast('Arquivos só em canais por enquanto 😉', true);
    S.socket.emit('send_dm', { dmId: S.dm.id, content });
  }
  input.value = '';
  input.style.height = 'auto';
}

/* ------------------------------- upload de imagens/arquivos */

$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (S.view !== 'server' || !S.channel) return toast('Escolhe um canal primeiro 😉', true);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const att = await api(`/api/channels/${S.channel.id}/upload`, { method: 'POST', body: fd });
    sendMessage(att);
  } catch (err) {
    toast('Arquivo não aceito (máx. 8MB: imagem, PDF, texto ou vídeo)', true);
  }
});

/* ================================================================ NAVEGAÇÃO RÁPIDA */

$('#btn-home').onclick = openHome;
$('#btn-add-server').onclick = openCreateServerModal;
$('#btn-user').onclick = openUserMenu;

document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#btn-user-box')) openUserMenu();
});

/* ================================================================ MODAIS */

function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-overlay').classList.remove('hidden');
  $('#modal-overlay').onclick = (e) => { if (e.target === $('#modal-overlay')) closeModal(); };
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  $('#modal').innerHTML = '';
}

const EMOJIS = ['🏫', '📚', '🎓', '🧠', '⚽', '🎮', '🎵', '🎬', '🧪', '🔢', '🌎', '✏️', '💻', '🎨', '🏀', '🚀'];

function openCreateServerModal() {
  openModal(`
    <div class="modal-title">Criar servidor</div>
    <div class="modal-sub">Um espaço para uma turma, um clube ou qualquer coisa da escola.</div>
    <div class="field"><label>Nome do servidor</label><input id="m-server-name" maxlength="40" placeholder="Ex.: 2º Ano B — Matemática" /></div>
    <div class="field"><label>Ícone</label>
      <div class="icon-grid">${EMOJIS.map(e => `<button type="button" data-e="${e}">${e}</button>`).join('')}</div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancelar</button>
      <button class="btn btn-primary" id="m-ok">Criar servidor</button>
    </div>`);

  let icon = null;
  document.querySelectorAll('#modal .icon-grid button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#modal .icon-grid button').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      icon = b.dataset.e;
    };
  });
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    const name = $('#m-server-name').value.trim();
    if (!name) return toast('Dá um nome pro servidor!', true);
    const server = await api('/api/servers', { method: 'POST', body: { name, icon } });
    S.servers.push(server);
    closeModal();
    renderRail();
    openServer(server.id);
  };
}

function openCreateChannelModal() {
  openModal(`
    <div class="modal-title">Criar canal</div>
    <div class="modal-sub">em ${esc(S.server.name)}</div>
    <div class="field"><label>Nome do canal</label><input id="m-channel-name" maxlength="30" placeholder="ex.: duvidas, sala-de-estudo, memes" /></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancelar</button>
      <button class="btn btn-primary" id="m-ok">Criar canal</button>
    </div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    const name = $('#m-channel-name').value.trim();
    if (!name) return toast('Dá um nome pro canal!', true);
    const channel = await api(`/api/servers/${S.server.id}/channels`, { method: 'POST', body: { name } });
    closeModal();
    S.server.channels.push(channel);
    renderChannels();
    openChannel(channel);
  };
}

function openInviteModal() {
  openModal(`
    <div class="modal-title">Convidar pra ${esc(S.server.name)}</div>
    <div class="modal-sub">Quem digitar esse código na aba “Entrar com convite” entra no servidor. Vale pra qualquer aluno da escola.</div>
    <div class="invite-code">${esc(S.server.invite_code)}</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-copy">📋 Copiar</button>
      <button class="btn btn-primary" id="m-close">Fechar</button>
    </div>`);
  $('#m-copy').onclick = async () => {
    await navigator.clipboard.writeText(S.server.invite_code).catch(() => {});
    toast('Código copiado!');
  };
  $('#m-close').onclick = closeModal;
}

function openJoinServerModal() {
  openModal(`
    <div class="modal-title">Entrar num servidor</div>
    <div class="modal-sub">Digite o código de convite que um colega te passou.</div>
    <div class="field"><label>Código de convite</label><input id="m-invite-code" maxlength="6" placeholder="ex.: XK2P9Q" style="text-transform:uppercase;letter-spacing:4px" /></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancelar</button>
      <button class="btn btn-primary" id="m-ok">Entrar</button>
    </div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    const code = $('#m-invite-code').value.trim();
    if (!code) return toast('Digita o código!', true);
    try {
      const server = await api('/api/servers/join', { method: 'POST', body: { code } });
      if (!S.servers.find(s => s.id === server.id)) S.servers.push(server);
      closeModal();
      renderRail();
      openServer(server.id);
    } catch (e) {
      toast('Código inválido. Confere com quem te passou.', true);
    }
  };
}

function openNewDmModal() {
  openModal(`
    <div class="modal-title">Nova conversa</div>
    <div class="modal-sub">Procure por nome ou e-mail de um aluno.</div>
    <div class="field"><label>Buscar</label><input id="m-dm-search" placeholder="nome ou @alunopueri.com.br" /></div>
    <div class="search-results" id="m-dm-results"></div>
    <div class="modal-actions"><button class="btn btn-ghost" id="m-close">Fechar</button></div>`);
  $('#m-close').onclick = closeModal;
  $('#m-dm-search').onfocus = () => doSearch();
  $('#m-dm-search').addEventListener('input', debounce(doSearch, 250));

  async function doSearch() {
    const q = $('#m-dm-search').value.trim();
    const box = $('#m-dm-results');
    if (!q) { box.innerHTML = ''; return; }
    let users = [];
    try { users = await api('/api/users/search?q=' + encodeURIComponent(q)); } catch (e) { return; }
    box.innerHTML = users.length
      ? users.map(u => `
        <div class="result" data-id="${u.id}">
          <div class="dm-avatar">${avatarHtml(u, 'dm-avatar', 12)}</div>
          <div style="min-width:0"><div class="r-name">${esc(u.name)}</div><div class="r-mail">${esc(u.email)}</div></div>
        </div>`).join('')
      : `<div style="padding:10px;color:var(--text-muted);font-size:13px">Ninguém encontrado. Talvez ainda não tenha entrado na Descola. 🤔</div>`;

    box.querySelectorAll('.result').forEach(el => {
      el.onclick = async () => {
        const dm = await api('/api/dms', { method: 'POST', body: { userId: Number(el.dataset.id) } });
        if (!S.dms.find(d => d.id === dm.id)) S.dms.push(dm);
        closeModal();
        refreshDms().then(() => openDm(dm.id));
      };
    });
  }
}

function openServerMenu() {
  const canDelete = S.server.my_role === 'dono' || S.me.role === 'admin';
  openModal(`
    <div class="modal-title">Opções do servidor</div>
    <div class="modal-sub">${esc(S.server.name)} · ${S.server.members.length} membros</div>
    <div class="modal-actions" style="justify-content:space-between">
      ${canDelete
        ? `<button class="btn btn-danger" id="m-del-server">Excluir servidor</button>`
        : `<span></span>`}
      <button class="btn btn-ghost" id="m-close">Fechar</button>
    </div>`);
  $('#m-close').onclick = closeModal;
  const del = $('#m-del-server');
  if (del) del.onclick = async () => {
    if (!confirm(`Excluir ${S.server.name} para todo mundo? Essa ação não tem volta.`)) return;
    await api(`/api/servers/${S.server.id}`, { method: 'DELETE' });
    S.servers = S.servers.filter(s => s.id !== S.server.id);
    closeModal();
    renderRail();
    openHome();
  };
}

function openUserMenu() {
  openModal(`
    <div class="modal-title">Minha conta</div>
    <div class="modal-sub">${esc(S.me.email)}</div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
      <div style="width:56px;height:56px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;background:#5865f2;color:#fff">${avatarHtml(S.me, '', 22)}</div>
      <div><div style="font-weight:700;font-size:16px">${esc(S.me.name)}</div>
      <div style="font-size:13px;color:var(--text-muted)">${S.me.role === 'admin' ? '🛡 Administrador(a) da plataforma' : 'Aluno(a) da escola'}</div></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-danger" id="m-logout">Sair</button>
      <button class="btn btn-ghost" id="m-close">Fechar</button>
    </div>`);
  $('#m-close').onclick = closeModal;
  $('#m-logout').onclick = () => { location.href = '/logout'; };
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ================================================================ AÇÕES DE CANAIS */

async function deleteChannel(ch) {
  if (!confirm(`Apagar o canal #${ch.name}? As mensagens somem.`)) return;
  await api(`/api/channels/${ch.id}`, { method: 'DELETE' });
  toast(`Canal #${ch.name} apagado.`);
}

/* ================================================================ GO */

boot();
