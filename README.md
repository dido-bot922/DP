# 🏫 Descola Perdizes

Um chat estilo Discord **para a nossa escola**, com login **Google OAuth** restrito
exclusivamente a e-mails `@alunopueri.com.br`.

Feito pela **RTechLabs** ⚡

---

## ✨ O que já funciona (MVP)

| Recurso | Como |
|---|---|
| 🔐 Login com Google | Só entra quem tem e-mail `@alunopueri.com.br` — verificado no servidor |
| 🏠 Servidores | Crie espaços por turma, clube ou matéria (com ícone e canal `#geral` automático) |
| 🔗 Convites | Cada servidor tem um código (ex.: `5AW925`) que qualquer aluno pode usar para entrar |
| 📢 Canais de texto | Crie canais por assunto (ex.: `duvidas`, `memes`, `sala-de-estudo`) |
| 💬 Mensagens em tempo real | Via WebSocket — chega na hora, sem refresh |
| ✍️ Indicador de digitação | "Fulano está digitando…" |
| 💌 Mensagens diretas (DM) | Converse em particular com qualquer aluno |
| 👑 Papéis | Dono e admin criam canais; dono pode excluir o servidor |
| 👥 Painel de membros | Veja quem está em cada servidor, com contagem online |
| 🟢 Presença online | Bolinha verde em quem está conectado (lista de membros e DMs) |
| 😄 Reações | Clique num emoji da mensagem para reagir (ou para desfazer) |
| @ Menções | Destaque na mensagem + aviso para quem foi mencionado |
| 🔴 Não-lidas | Badge com contador nos canais com mensagem nova |
| 📎 Imagens/arquivos | Anexe imagens, PDFs e textos no chat (até 8 MB) |

## 🛠️ Tecnologias

- **Backend:** Node.js + Express + Socket.IO
- **Banco:** SQLite (um arquivo só, sem instalar nada — `better-sqlite3`)
- **Auth:** Passport + Google OAuth 2.0
- **Frontend:** HTML/CSS/JS puro, tema escuro estilo Discord, em português

---

## 🚀 Como rodar

### 1. Instalar

```bash
npm install
```

### 2. Criar as credenciais do Google OAuth (10 minutos, 1ª vez)

1. Acesse [console.cloud.google.com](https://console.cloud.google.com) com a conta da escola (admin do Workspace).
2. **Crie um projeto** → nome: `Descola Perdizes`.
3. Menu ☰ → **APIs & serviços → Tela de consentimento OAuth**:
   - Tipo de usuário: **Interno** (assim só contas do domínio `alunopueri.com.br` conseguem autorizar — perfeito pra escola).
   - Adicione o escopo **`email`, `profile`, `openid`**.
4. Menu ☰ → **APIs & serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo: **Aplicativo da web**
   - **URIs de redirecionamento autorizados:** `http://localhost:3000/auth/google/callback`
   - (Se rodar em outro lugar, troque o endereço — precisa bater com `BASE_URL` do `.env`.)
5. Copie o **Client ID** e o **Client Secret**.

### 3. Configurar

```bash
cp .env.example .env
```

Edite o `.env`:

```env
GOOGLE_CLIENT_ID=seu-client-id
GOOGLE_CLIENT_SECRET=seu-client-secret
SESSION_SECRET=algo-aleatorio-bem-grande
```

O domínio `alunopueri.com.br` já vem travado em `ALLOWED_DOMAIN` (não precisa mexer).
E-mails admin globais podem ser listados em `ADMIN_EMAILS` (opcional).

### 4. Subir

```bash
npm start          # http://localhost:3000
npm run dev        # com reload automático ao editar
```

Pronto! Abra o navegador, clique em **Entrar com o Google** e logue com o e-mail da escola.

> ⚠️ **Importante:** o login **só** funciona com conta `@alunopueri.com.br`.
> Qualquer outro e-mail é barrado na hora (aparece o aviso na tela de login).

---

## 🧪 Modo de teste sem o Google (DEV)

Pra desenvolver/testar a interface sem depender do Google Cloud:

```env
DEV_LOGIN=true
```

Com isso, dá pra entrar direto:

```
http://localhost:3000/auth/dev?email=fulano@alunopueri.com.br&name=Fulano
```

(Só funciona com e-mail do domínio permitido. **Nunca** deixe `DEV_LOGIN=true` em produção.)

Para testar o tempo real de ponta a ponta (2 usuários, canal e DM):

```bash
npm run test:socket     # requer servidor rodando com DEV_LOGIN=true
```

---

## 📁 Estrutura

```
descola-perdizes/
├── src/
│   ├── server.js     # Express, rotas da API, sessão
│   ├── auth.js       # Google OAuth + trava de domínio
│   ├── db.js         # SQLite (schema + consultas)
│   └── sockets.js    # Tempo real (mensagens, digitação)
├── public/
│   ├── index.html    # SPA
│   ├── style.css     # Tema escuro estilo Discord
│   └── app.js        # Lógica do frontend
├── tests/
│   └── socket.test.js
└── data/             # Banco SQLite (criado sozinho, não versionar)
```

Os dados ficam todos em `data/descola.db` — pra recomeçar do zero, é só apagar essa pasta.

## 🗺️ Próximos passos (v3)

- [ ] Reações em DMs
- [ ] Deletar/editar mensagens
- [ ] Threads
- [ ] Notificações push
- [ ] Persistência real (Postgres) no deploy

## ☁️ Deploy no Render (de graça, pra escola usar de verdade)

1. Crie um repositório no [GitHub](https://github.com) e suba o projeto (sem `node_modules`, sem `data/`, sem `.env`).
2. Em [render.com](https://render.com) (conta gratuita) → **New → Web Service** → conecte o repo.
3. Render detecta o `render.yaml` — preencha as variáveis:
   - `BASE_URL`: `https://SEU-APP.onrender.com` (a URL que o Render te der)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: as mesmas credenciais
   - `SESSION_SECRET`: gere um valor aleatório
4. Depois do primeiro deploy, adicione no Google Cloud Console (Credenciais → seu Client ID):
   `https://SEU-APP.onrender.com/auth/google/callback` — e pode remover a URI do túnel.
5. Pronto: `https://SEU-APP.onrender.com` com HTTPS, acessível de qualquer aparelho.

> ⚠️ No plano gratuito o Render "dorme" após ~15 min sem uso (a 1ª visita demora ~1 min pra acordar)
> e o disco é temporário (mensagens somem ao redeployar). Pra uso sério da escola:
> anexe um **disco** (paid) ou troque o SQLite por um Postgres grátis do Render — me chama que eu adapto.

## 🔒 Notas de segurança

- O domínio é verificado **no servidor** (nunca confie só no frontend).
- Quem não é membro não vê canais nem mensagens (verificado em toda rota).
- Mensagens são renderizadas como texto puro (sem risco de XSS).
- Para produção de verdade: use HTTPS, troque `SESSION_SECRET`, e considere
  um store de sessão persistente (ex.: `connect-sqlite3`).
