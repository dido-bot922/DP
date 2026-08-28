'use strict';
/* Teste v2: presença, reações, menção, não-lidas, upload */
const fs = require('fs');
const { io } = require('socket.io-client');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
let ok = 0, fail = 0;
function check(name, cond) { cond ? (ok++, console.log('✅ ' + name)) : (fail++, console.log('❌ ' + name)); }

async function login(email, name) {
  const res = await fetch(`${BASE}/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`, { redirect: 'manual' });
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const sid = setCookies.map(c => c.split(';')[0]).find(c => c.startsWith('connect.sid'));
  if (!sid) throw new Error('sem cookie');
  return sid;
}

async function api(path, cookie, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: opts.body instanceof FormData ? { Cookie: cookie } : { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body !== undefined ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(path + ' → ' + res.status + ' ' + JSON.stringify(data).slice(0, 100));
  return data;
}

async function main() {
  const salt = Date.now().toString(36);
  const sidA = await login(`ana.${salt}@alunopueri.com.br`, 'Ana V2');
  const sidB = await login(`joao.${salt}@alunopueri.com.br`, 'Joao V2');
  console.log('✅ usuários criados');

  const server = await api('/api/servers', sidA, { method: 'POST', body: { name: 'V2 Teste', icon: '🧪' } });
  await api('/api/servers/join', sidB, { method: 'POST', body: { code: server.invite_code } });
  const ch = server.channels[0];
  console.log('✅ servidor/canal prontos');

  // ------- upload -------
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('ola descola!')], { type: 'text/plain' }), 'nota.txt');
  const att = await api(`/api/channels/${ch.id}/upload`, sidA, { method: 'POST', body: fd });
  check('upload de arquivo', att.url && att.url.startsWith('/uploads/'));
  const fileRes = await fetch(BASE + att.url);
  check('arquivo servido', fileRes.ok && (await fileRes.text()) === 'ola descola!');

  // ------- sockets: presença, reação, menção, mensagem com anexo -------
  const a = io(BASE, { extraHeaders: { Cookie: sidA }, transports: ['websocket'] });
  const b = io(BASE, { extraHeaders: { Cookie: sidB }, transports: ['websocket'] });

  const hard = setTimeout(() => { console.log(`❌ TIMEOUT (${ok} ok, ${fail} fail)`); process.exit(1); }, 10000);
  const done = () => { clearTimeout(hard); console.log(fail === 0 ? `🎉 TODOS OS TESTES OK (${ok})` : `⚠️ ${fail} falhas`); process.exit(fail === 0 ? 0 : 1); };

  const seen = { presence: false, reaction: false, mention: false, unread: false };

  b.on('presence', ({ onlineIds }) => {
    if (onlineIds.length >= 2 && !seen.presence) { seen.presence = true; check('presença (2 online)', true); maybeDone(); }
  });

  b.on('reaction_update', ({ messageId, emoji, userId, added }) => {
    if (added && emoji === '🔥' && !seen.reaction) { seen.reaction = true; check('reação em tempo real', true); maybeDone(); }
  });

  b.on('mention', ({ from, channelName }) => {
    if (!seen.mention) { seen.mention = true; check('menção @ notificada', from === 'Ana V2' && channelName === ch.name); maybeDone(); }
  });

  b.on('new_message', (msg) => {
    if (msg.attachment_url && !seen.uploadMsg) { seen.uploadMsg = true; check('mensagem com anexo chega no canal', true); maybeDone(); }
  });

  // A reage na própria mensagem recém-enviada (não num id fixo)
  a.on('new_message', (msg) => {
    if (msg.content && msg.content.includes('bora') && !seen.sent) {
      seen.sent = true;
      setTimeout(() => a.emit('add_reaction', { messageId: msg.id, emoji: '🔥' }), 200);
    }
  });

  function maybeDone() {
    if (seen.presence && seen.reaction && seen.mention && seen.uploadMsg) {
      // testa não-lidas via API: b ainda não abriu o canal, deve ter unread >= 2
      api(`/api/servers/${server.id}`, sidB).then(srv => {
        const unread = (srv.unread && srv.unread[ch.id]) || 0;
        check('não-lidas contadas para B', unread >= 1);
        // B marca leitura e confere que zera
        b.emit('mark_read', { channelId: ch.id });
        setTimeout(async () => {
          const srv2 = await api(`/api/servers/${server.id}`, sidB);
          check('marcar leitura zera não-lidas', ((srv2.unread || {})[ch.id] || 0) === 0);
          done();
        }, 500);
      });
    }
  }

  Promise.all([new Promise(r => a.on('connect', r)), new Promise(r => b.on('connect', r))])
    .then(() => {
      setTimeout(() => {
        a.emit('send_message', { channelId: ch.id, content: 'oi @Joao V2, bora!', attachment: att });
        setTimeout(() => a.emit('add_reaction', { messageId: 1, emoji: '🔥' }), 300);
      }, 300);
    })
    .catch(e => { console.log('❌ conexão:', e.message); process.exit(1); });
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
