'use strict';
/* Teste de tempo real — cria 2 usuários de dev, um servidor, manda mensagem de
   canal e DM, e confere que o outro usuário recebe tudo em tempo real.
   Requer: servidor rodando com DEV_LOGIN=true (ver README). */

const { io } = require('socket.io-client');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function login(email, name) {
  const res = await fetch(`${BASE}/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`, { redirect: 'manual' });
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  const sid = setCookies.map(c => c.split(';')[0]).find(c => c.startsWith('connect.sid'));
  if (!sid) throw new Error('sem cookie de sessão');
  return sid;
}

async function api(path, cookie, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function main() {
  const salt = Date.now().toString(36);
  const sidA = await login(`ana.${salt}@alunopueri.com.br`, 'Ana Teste');
  const sidB = await login(`joao.${salt}@alunopueri.com.br`, 'Joao Teste');
  console.log('✅ 2 usuários de dev criados');

  const server = await api('/api/servers', sidA, {
    method: 'POST',
    body: { name: 'Servidor de Teste', icon: '🧪' },
  });
  console.log('✅ servidor criado, código de convite:', server.invite_code);

  await api('/api/servers/join', sidB, { method: 'POST', body: { code: server.invite_code } });
  console.log('✅ usuário B entrou pelo convite');

  const dm = await api('/api/dms', sidB, { method: 'POST', body: { userId: 1 } }).catch(() => null);

  const a = io(BASE, { extraHeaders: { Cookie: sidA }, transports: ['websocket'] });
  const b = io(BASE, { extraHeaders: { Cookie: sidB }, transports: ['websocket'] });

  const hard = setTimeout(() => { console.log('❌ TIMEOUT — tempo real falhou'); process.exit(1); }, 8000);

  const got = {};
  b.on('new_message', (msg) => {
    if (msg.content === 'oi teste canal') { got.canal = true; console.log('✅ canal em tempo real'); }
    maybeDone();
  });
  b.on('new_dm_message', (msg) => {
    if (msg.content === 'oi teste dm') { got.dm = true; console.log('✅ DM em tempo real'); }
    maybeDone();
  });
  function maybeDone() {
    if (got.canal && got.dm) { clearTimeout(hard); console.log('🎉 TESTE OK'); process.exit(0); }
  }

  Promise.all([new Promise(r => a.on('connect', r)), new Promise(r => b.on('connect', r))])
    .then(() => {
      const ch = server.channels[0];
      a.emit('send_message', { channelId: ch.id, content: 'oi teste canal' });
      setTimeout(() => {
        if (dm) a.emit('send_dm', { dmId: dm.id, content: 'oi teste dm' });
      }, 500);
    })
    .catch((e) => { console.log('❌ conexão falhou:', e.message); process.exit(1); });
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
