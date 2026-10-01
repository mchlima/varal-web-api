# varal-web-api

API do Varal (NestJS): REST em `/api/v1` e tempo real (Socket.IO) em `/ws`.

Specs e decisões do produto: [varal-docs](https://github.com/mchlima/varal-docs) (localmente em `../varal-docs`). Regras para agentes: [`AGENTS.md`](AGENTS.md).

## Stack

Node 26 (`>=26`, ver `.nvmrc`), pnpm 10, NestJS 12 (ESM, Express 5), TypeScript estrito, zod 4 (validação nativa do Nest via Standard Schema), Prisma 7.10.0 com `@prisma/adapter-pg`, PostgreSQL 17, pg-boss 12 (filas), `@node-rs/argon2`, `jose` (JWT), nodemailer, OpenAPI 3.1 com `@nestjs/swagger`, Vitest 5 com SWC, ESLint 10 e Prettier.

## Primeiros passos

```bash
git config core.hooksPath .githooks          # uma vez por clone (bloqueio da main)
docker compose -f ../varal-infra/dev/compose.yml up -d   # Postgres de desenvolvimento (varal-dev-db)
# Mailpit para os e-mails de desenvolvimento: SMTP em localhost:1025, caixa em http://localhost:8025
scripts/worktree.sh new feat/minha-tarefa    # worktree com porta, .env.local, dependências e banco próprios
```

Sem o script, num checkout já existente: `pnpm install`, copie `.env.example` para `.env` e ajuste.

## Comandos

| Comando                                   | O que faz                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm install`                            | Instala dependências e gera o Prisma Client em `src/generated/prisma`             |
| `pnpm dev`                                | Sobe a API em modo watch (porta `PORT`, padrão 3000)                              |
| `pnpm build` / `pnpm start`               | Compila para `dist/` / roda `dist/main.js`                                        |
| `pnpm test`                               | Testes unitários, e2e e de integração (estes só com `DATABASE_URL_TEST`)          |
| `pnpm test:watch`                         | Testes em modo watch                                                              |
| `pnpm lint`                               | ESLint com regras que usam tipos                                                  |
| `pnpm format` / `pnpm format:check`       | Prettier                                                                          |
| `pnpm typecheck`                          | `tsc --noEmit`                                                                    |
| `pnpm openapi`                            | Gera o `openapi.json` sem subir servidor nem conectar no banco                    |
| `pnpm db:migrate`                         | `prisma migrate dev` (só na máquina de desenvolvimento)                           |
| `pnpm db:deploy`                          | `prisma migrate deploy` (CI e deploy)                                             |
| `pnpm db:generate`                        | Regenera o Prisma Client (rode depois de `db:migrate`)                            |
| `pnpm db:seed`                            | Dados de exemplo, idempotente (o `scripts/worktree.sh new` já roda)               |
| `pnpm admin:create -- --name … --email …` | Cria um admin da plataforma e envia o convite ([Primeiro admin](#primeiro-admin)) |

Saúde: `GET /api/v1/health` responde `{ "status": "ok", "db": "ok" | "unavailable" }`.

## Ambiente

Variáveis em [`.env.example`](.env.example), validadas com zod no boot (a API não sobe se estiverem erradas). Em desenvolvimento, `.env.local` e `.env` são carregados nessa ordem.

- `AUTH_PANEL_JWT_SECRET` e `AUTH_ADMIN_JWT_SECRET` (assinatura do token de acesso, um por contexto, diferentes entre si) e `EMAIL_PAYLOAD_SECRET` (cifra dos jobs de e-mail): mínimo de 32 caracteres. Obrigatórios em produção; fora dela, se faltarem, a API gera valores aleatórios a cada início. O `scripts/worktree.sh new` grava valores aleatórios no `.env.local`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (padrão `Varal <nao-responda@kratinho.com.br>`), `SUPPORT_CONTACT` (opcional, rodapé dos e-mails). Desenvolvimento: Mailpit em `localhost:1025`. Produção: SMTP Locaweb, com `SMTP_USER` e `SMTP_PASSWORD` obrigatórios e STARTTLS exigido quando `SMTP_SECURE=false`; as credenciais ficam só no `.env` do VPS.
- `PANEL_URL` e `ADMIN_URL`: base dos links de convite e redefinição (dev `http://localhost:3100` e `http://localhost:3200`; https obrigatório em produção).

## Worktrees (spec 01, seção 4.1)

```bash
scripts/worktree.sh new <tipo>/<descricao>   # ../.worktrees/varal-web-api/<tipo>-<descricao>, a partir de origin/main
scripts/worktree.sh list                     # branch, PORT_OFFSET, porta e banco de cada worktree
scripts/worktree.sh remove <tipo>-<descricao>  # recusa se houver alterações sem commit; apaga só os bancos dele
```

Cada worktree recebe o menor `PORT_OFFSET` livre (1 a 99), API em `3000 + PORT_OFFSET`, e os bancos `varal_<slug>` e `varal_<slug>_test` no Postgres de desenvolvimento. O checkout principal usa `PORT_OFFSET=0`.

## Fundação (spec 01)

### Modelo de dados

Schema em [`prisma/schema.prisma`](prisma/schema.prisma), migration em `prisma/migrations/`. Tabelas em snake_case, modelos em PascalCase, ids UUID v7 gerados pela aplicação, datas `timestamptz` com milissegundos. Regras que o Prisma não expressa ficam só no SQL da migration (listadas no comentário de cada modelo):

- `organizations.access_code`: 6 caracteres sem 0/O e 1/I (`CHECK`); gerado por `generateAccessCode()`.
- E-mails de donos e admins sempre em minúsculas (`CHECK`), únicos globalmente.
- `staff_members`: índice único `(organization_id, lower(username))` e `CHECK` do formato do username.
- `staff_unit_permissions`: chaves estrangeiras compostas com `organization_id`, para colaborador e unidade serem sempre da mesma organização. `station_ids` ainda sem FK (estações vêm na spec 03).
- `audit_logs`: somente inserção; um trigger recusa `UPDATE` e `DELETE`.

### Contexto da requisição

`RequestContextMiddleware` abre um `AsyncLocalStorage` por requisição com `requestId` (devolvido em `X-Request-Id`), `deviceId` (`X-Device-Id`, UUID; inválido → 400), `ip` (de `X-Forwarded-For` só vindo de proxy em rede privada, RN-01.19) e `auth`.

O `AuthGuard` (seção Autenticação) valida o cookie e chama `setAuthContext({ organizationId, actor, impersonatorId, sessionId })` uma única vez por requisição (uma segunda chamada falha). Fora de HTTP (jobs, scripts, testes), use `runWithContext(systemContext({ auth }), fn)`.

Nos testes, `createTestApp()` troca o `AuthGuard` pelo `test/support/stub-auth.ts`, que lê cabeçalhos `X-Test-*` (nunca importado por `src/`); `createTestApp({ auth: 'real' })` mantém a autenticação real, com os cookies do login (`test/support/auth-kit.ts`).

### Isolamento entre organizações

- `PrismaService` (use `prisma.db` e `prisma.transaction`) aplica uma client extension que, nos modelos de `TENANT_MODELS`, põe a organização do contexto no `where` de leituras, contagens, agregações, updates e deletes, e no `data` de creates e upserts. Sem organização no contexto, a consulta falha (`TenantScopeError`, 500), nunca devolve dados de outra organização. Gravar `organizationId` de outra organização também falha. `Organization` é filtrada pelo próprio id e não pode ser criada nem apagada por esse cliente.
- Os tipos do Prisma exigem `organizationId` no `create`: passe `requireOrganizationId()`; a extensão confere que é a do contexto.
- Registro de outra organização se comporta como inexistente: `findUnique` devolve `null`, `update`/`delete` dão P2025, que o filtro de erros transforma em 404 `NOT_FOUND` (CA-01.02).
- `PlatformPrismaService` é o cliente **sem filtro**, só para o módulo do admin (spec 02), a autenticação (busca do usuário antes de saber a organização) e jobs. Uma regra do ESLint impede importá-lo fora de `src/admin`, `src/auth`, `src/jobs` e `src/prisma`. Os dois clientes dividem o mesmo pool de no máximo 7 conexões (plano 2.1).

**Limites (revisar no PR):**

- `$queryRaw`/`$executeRaw` **não** são filtrados: escreva `organization_id = ${organizationId}` à mão.
- Escritas aninhadas (`create: { permissions: { create: [...] } }`) não recebem a organização: use operações de primeiro nível. `include`/`select` de relações seguem a linha raiz, que já é da organização; as FKs compostas protegem as relações de tenant.
- Consultas do Prisma são preguiçosas e rodam no `await`: aguarde dentro do contexto (`runWithContext(ctx, async () => await query)`), senão o contexto se perde e a consulta falha.
- Tabelas com `organization_id` opcional (`sessions`, `audit_logs`, `email_logs`, `idempotency_keys`) guardam também dados da plataforma e não são filtradas automaticamente.

**Teste de isolamento obrigatório** para cada recurso novo, com o kit em [`test/support/isolation-kit.ts`](test/support/isolation-kit.ts): `describeTenantIsolation('Modelo', {...})` (camada de dados) e `expectNotFoundForOtherTenant(app, {...})` (HTTP, 404; com `as` para a autenticação simulada ou `headers: { Cookie }` para a real).

### Erros

Todo erro sai como `{ "error": { "code", "message", "details" } }` (schema `ErrorResponse` no OpenAPI, resposta `default` de toda rota). `code` estável em inglês, `message` em pt-BR. Lance `AppError.of('NOT_FOUND')` ou, com código do módulo, `new AppError('TAB_ALREADY_CLOSED', 409, 'Esta comanda já foi fechada.')`. Validação zod vira `VALIDATION_FAILED` com `details.fields: [{ path, message }]` (mensagens do zod em pt-BR). Erros inesperados viram `INTERNAL_ERROR` sem mensagem interna em produção; a pilha vai só para o log.

### Paginação

`@Query({ schema: PaginationQuerySchema })` (`?limit=50&cursor=...`, limite 1 a 100), `pageArgs(query)` no `findMany` e `toPage(rows, limit)` → `{ data, nextCursor }`. O cursor é opaco (id UUID v7, em ordem de criação). Resposta nomeada com `pageSchema('UnitPage', UnitSchema)`.

### Idempotência

`@Idempotent()` numa rota de escrita aceita `Idempotency-Key` (UUID). A primeira requisição reserva a chave por sujeito; o handler roda numa transação ambiente (`prisma.transaction` entra nela) e a resposta é gravada nessa mesma transação. Repetição em 24 h devolve o mesmo status e corpo com `Idempotent-Replayed: true`. Mesma chave com outro corpo → 409 `IDEMPOTENCY_KEY_REUSED`; enquanto a primeira roda → 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS`. Respostas 4xx são guardadas; 5xx liberam a chave. `IdempotencyService.purgeExpired()` apaga as vencidas, chamada pelo job diário de limpeza (seção Jobs).

### Concorrência

`updateWithVersion(prisma.db.tab, { where: { id }, expectedVersion, data })` atualiza só se a `version` bater e a incrementa; senão 409 `VERSION_CONFLICT` com `details.currentVersion` (ou o código do módulo via `onConflict`).

### Auditoria

`auditService.record(tx, { action, entityType, entityId, before, after, metadata })` dentro da transação da ação. Ator, admin do "entrar como", aparelho, IP e `requestId` vêm do contexto; `changes` guarda só os campos alterados (`{ before, after }`), sem segredos.

### Datas

`src/common/time.ts`: `Temporal` (global no Node 26) para "agora" e dias em `America/Sao_Paulo`; `toDate`/`toInstant` convertem na borda com o `Date` do Prisma.

### Seed

`pnpm db:seed`: organização "Espetinho do Piloto" (`pilot`, código `ESPT26`), unidade "Barraca da Praça", dono `dono@varal.local`, colaboradores `ana` e `bruno` e admin `admin@varal.local`. Estações e fluxo padrão vêm com a spec 03.

**Senha de desenvolvimento `varal12345`** para o dono, os dois colaboradores e o admin. Só existe no seed, que se recusa a rodar com `NODE_ENV=production`; ela é gravada apenas enquanto a senha está vazia, então uma senha trocada localmente sobrevive a um novo seed.

```bash
# Login do dono com curl (cookies em jar.txt); o X-Device-Id é um UUID qualquer do aparelho
curl -c jar.txt -H 'X-Device-Id: 0192f000-0000-7000-8000-000000000001' -H 'content-type: application/json' \
  -d '{"email":"dono@varal.local","password":"varal12345"}' http://localhost:3000/api/v1/auth/owner/login
curl -b jar.txt http://localhost:3000/api/v1/auth/me
```

## Primeiro admin

Enquanto a tela de usuários do admin não existe (spec 02, fase 3), o primeiro acesso ao admin em produção é criado por linha de comando:

```bash
# Produção (VPS): dentro do container da API, que já tem DATABASE_URL, ADMIN_URL e o SMTP no ambiente
docker exec varal-api node dist/cli/create-platform-admin.js --name "Nome da Pessoa" --email pessoa@exemplo.com

# Desenvolvimento (banco do worktree, e-mail no Mailpit em http://localhost:8025)
pnpm admin:create -- --name "Nome da Pessoa" --email pessoa@exemplo.com
```

- Valida nome e e-mail (guardado em minúsculas) e recusa, com código de saída 1, se já existir admin com o e-mail; argumentos inválidos saem com 2 e `--help` mostra o uso.
- Numa transação: cria o `platform_admin` ativo e sem senha, gera o convite (7 dias, seção 7.4), enfileira o e-mail `admin_invite` e grava a auditoria `platform_admin.created` com ator `system` (o `actor_type` que jobs e scripts já usam), `metadata.source = "cli"` e `request_id` `cli-<uuid>`.
- **Quem envia o e-mail é o worker da API em execução** (fila `email.send`): o comando sobe só um contexto enxuto do Nest com o pg-boss em modo produtor (`PG_BOSS_WORKERS = false`: sem workers, sem cron), enfileira e encerra. Em produção, rodando com `docker exec` no `varal-api`, o e-mail sai pelo worker do próprio container; em desenvolvimento, deixe o `pnpm dev` rodando para o convite chegar ao Mailpit.
- A saída nunca mostra o token nem o link, só `Convite enviado para <email>`. Se o convite vencer antes do primeiro acesso, use "Esqueci a senha" na tela de login do admin.
- **RBAC (fase 3):** este admin não tem papel, porque os papéis ainda não existem na API. Quando a spec 02 trouxer `roles` e `platform_admin_roles`, a migration ou o seed dos papéis deve dar o papel **Super admin** ao admin criado por este comando (RN-02.05 exige pelo menos um Super admin ativo).

## Autenticação (spec 01, seção 7)

Rotas em [`src/auth`](src/auth): `POST /auth/owner/login`, `POST /auth/staff/login` (`accessCode`, `username`, `password`; CA-01.03), `GET /auth/access-code/{code}`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password/forgot|reset|change` e, no contexto do admin, `POST /admin/auth/login|refresh|logout`, `GET /admin/auth/me` e `POST /admin/auth/password/forgot|reset|change`.

**Senhas.** argon2id (`memoryCost 19456`, `timeCost 2`, `parallelism 1`), refeito no login quando os parâmetros mudam; mínimo de 8 caracteres. Usuário inexistente, senha errada, usuário inativo ou sem senha dão a mesma resposta (`INVALID_CREDENTIALS`), depois do mesmo trabalho do argon2. **Bloqueio:** 10 erros seguidos para o mesmo identificador (e-mail; código + usuário no colaborador) bloqueiam por 15 minutos (`429 LOGIN_TEMPORARILY_LOCKED`), inclusive para identificadores que não existem, então o bloqueio não revela quem existe. O contador fica no banco (`login_throttles`, com hash do identificador) e zera no login certo.

**Sessão.** Token de acesso JWT HS256 de 15 min e token de renovação opaco (`<id da sessão>.<32 bytes>`) de 30 dias, só com o hash SHA-256 no banco. Cada renovação gira o token e empurra a validade 30 dias (validade deslizante).

| Contexto         | Cookie de acesso                   | Cookie de renovação                                   | Segredo do JWT                                   |
| ---------------- | ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| App dos clientes | `__Host-varal_at` (`Path=/`)       | `__Secure-varal_rt` (`Path=/api/v1/auth`)             | `AUTH_PANEL_JWT_SECRET`, audiência `varal-panel` |
| Admin            | `__Host-varal_admin_at` (`Path=/`) | `__Secure-varal_admin_rt` (`Path=/api/v1/admin/auth`) | `AUTH_ADMIN_JWT_SECRET`, audiência `varal-admin` |

- Todos `HttpOnly`, `Secure`, `SameSite=Strict`, sem `Domain`. O prefixo `__Host-` exige `Path=/` e impede que outro subdomínio de `kratinho.com.br` grave ou sobrescreva o cookie de acesso. Navegadores aceitam `Secure` em `http://localhost`.
- **Contextos separados (CA-01.04):** rotas em `/api/v1/admin` (pelo caminho, sem diferenciar maiúsculas, ou por `@AdminArea()`) só aceitam o cookie do admin; as demais só o do app. Segredo, audiência e tipo de sujeito diferentes: um token nunca vale no outro contexto.
- **Guard global (`AuthGuard`)**: rotas são protegidas por padrão; as abertas usam `@Public()`. O guard confere o JWT **e a linha da sessão a cada requisição** (uma busca por chave primária): logout, troca ou redefinição de senha e desativação cortam o acesso na hora, sem esperar os 15 min do token (o CA-01.05 aceita até 15 min; aqui é imediato no HTTP). O `X-Device-Id`, quando enviado, tem de ser o da sessão.
- `X-Device-Id` (UUID) é obrigatório no login e gravado na sessão. Novo login do mesmo sujeito no mesmo aparelho encerra a sessão anterior desse aparelho.
- **Reuso do token de renovação:** apresentar o token anterior à última rotação revoga a sessão inteira (`refresh_token_reused`), porque indica cópia. Nos 30 s seguintes à rotação ele só é recusado, sem revogar (duas abas ou um reenvio depois de resposta perdida). Só o token imediatamente anterior é reconhecido; tokens mais antigos são apenas recusados.
- **Logout** encerra a sessão do aparelho (funciona só com o cookie de renovação, se o de acesso já venceu). **Troca de senha** encerra todas as sessões do usuário e abre uma nova para o aparelho atual. **Redefinição** (link) encerra todas. `AuthService.revokeSessionsInTransaction` serve à desativação de colaborador (RN-03.17, spec 03).
- Toda revogação emite, depois do commit, o evento interno `auth.sessions_revoked` (`AuthEvents.onSessionsRevoked`); o tempo real desconecta na hora os sockets daquelas sessões (seção Tempo real).
- Organizações `suspended` ou `canceled` continuam entrando: a RN-01.01 só bloqueia abrir turno.
- **Auditoria:** `auth.login`, `auth.logout`, `auth.password_changed`, `auth.password_reset`, `auth.invite_accepted`, `auth.password_link_issued` e `auth.sessions_revoked`. Falhas de login **não** vão para `audit_logs` (somente inserção; tentativas com identificadores inventados encheriam a tabela): alimentam o bloqueio e o bloqueio vai para o log da aplicação.
- **Limite por IP em memória** (`RateLimiter`): logins 20/min, "esqueci a senha" 5 a cada 15 min, consulta de código 30/min, redefinição e troca de senha 10 a cada 15 min (`429 RATE_LIMITED`). Vale por instância e zera no restart; com mais de uma instância precisaria ir para o banco.
- RBAC do admin (permissões por rota) e "entrar como" (`sessions.impersonation_id`, `impersonatorId` no contexto) chegam com a spec 02.

**Convite e redefinição (seção 7.4).** `PasswordTokenService`: 32 bytes aleatórios, só o hash no banco, uso único; gerar um novo invalida os anteriores do mesmo tipo; convite 7 dias, redefinição 1 h; **RN-01.02** no máximo 3 links de redefinição por usuário por hora. `PasswordLinkService` gera o link `{PANEL_URL|ADMIN_URL}/definir-senha#token=...&tipo=convite|redefinicao` (o token vai no fragmento, que o navegador não envia a servidores nem em `Referer`) e enfileira o e-mail:

- `issueOwnerInvite(tx, ownerId)`: chamado pelo admin ao criar a organização (fase 3, RN-02.09), na mesma transação;
- `requestOwnerPasswordReset(email)` / `requestAdminPasswordReset(email)`: "Esqueci a senha", sempre a mesma resposta e pelo menos 400 ms, exista ou não o e-mail (**RN-01.03**);
- `issueStaffPasswordReset(staffMemberId, { sendEmail })`: redefinição do colaborador pelo dono (RN-03.18; a rota fica para a spec 03); devolve o link para copiar ou mandar por WhatsApp;
- `issueAdminInvite(tx, adminId)`: convite de admin (spec 02).

## Tempo real (spec 01, seção 10)

Socket.IO 4 em [`src/realtime`](src/realtime), no mesmo servidor e porta da API, caminho **`/ws`**, só para o app dos clientes (dono e colaborador).

### Conexão

```ts
import { io } from 'socket.io-client';

const socket = io(API_BASE_URL, {
  path: '/ws',
  transports: ['websocket'], // obrigatório: o servidor não aceita long-polling
  withCredentials: true, // o navegador manda o cookie __Host-varal_at
  auth: { deviceId }, // o mesmo UUID do X-Device-Id
});
```

- **Só WebSocket** (`transports: ['websocket']`): sem long-polling não existe sticky session (cada requisição de polling poderia cair em outra instância), e o handshake é uma única requisição de upgrade que leva o cookie e o `Origin`. Todos os navegadores suportados têm WebSocket.
- **Ping a cada 25 s** (`pingInterval` padrão do Socket.IO; `pingTimeout` 20 s): passa pelo limite de 100 s sem tráfego do Cloudflare e derruba aparelho morto em menos de um minuto.
- **Origem (RN-01.20):** CORS não vale para WebSocket, então o `Origin` do upgrade é conferido contra a mesma lista exata de `CORS_ORIGINS` (`allowRequest`); fora da lista, ou sem `Origin`, a conexão é recusada antes do Socket.IO. Scripts fora do navegador mandam o cabeçalho (`extraHeaders: { origin }`).
- **Autenticação no handshake:** o cookie de acesso do app (`__Host-varal_at`) é validado pelo mesmo `AuthService.authenticate` das rotas HTTP (JWT do contexto do app e linha da sessão). O token do admin nunca é aceito, com qualquer nome de cookie (CA-01.04). O aparelho vai em **`auth.deviceId`** do handshake (navegadores não mandam cabeçalhos próprios em WebSocket; na query ele apareceria nos logs de acesso), é obrigatório e tem de ser o da sessão.
- **Recusa:** o cliente recebe `connect_error` com `err.data` no formato `ErrorResponse` e `code` em `RealtimeErrorCode`: `UNAUTHENTICATED` (sem cookie, token inválido ou vencido, sessão encerrada, outro aparelho, token do admin) ou `DEVICE_ID_REQUIRED`. Em `UNAUTHENTICATED`, o app renova a sessão por REST (`POST /auth/refresh`) e conecta de novo; se a renovação falhar, volta ao login.

### Salas

| Sala                  | Quem entra (automaticamente, no handshake)                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `unit:{unitId}`       | Dono: todas as unidades **ativas** da organização. Colaborador: as unidades ativas de `staff_unit_permissions`    |
| `station:{stationId}` | Colaborador: as estações de `station_ids` dessas unidades. Dono: nenhuma até a spec 03 criar a tabela de estações |

- As salas são calculadas pelo cliente do Prisma filtrado pela organização da sessão; nunca entra sala de outra organização (CA-01.02).
- **Opcional:** `socket.emitWithAck('rooms.leave', { room })` sai de uma sala (ex.: estações que o aparelho não está operando) e `rooms.join` volta a ela, conferida no servidor contra as permissões atuais. A resposta é `RealtimeRoomAck`: `{ ok: true, rooms }` ou `{ ok: false, error }` com `ROOM_FORBIDDEN` (sala inexistente, de outra organização ou sem permissão; mesma resposta nos três casos) ou `VALIDATION_FAILED`.
- Uma sala interna por sessão (`session:{id}`) serve para encerrar os sockets dela; o cliente não consegue entrar nela.
- As salas são fixadas na conexão. Mudança de permissão (spec 03) vale na próxima conexão; quem a fizer deve chamar `RealtimeService.endSessions` ou revogar as sessões se precisar efeito imediato.

### Desconexão

| Evento recebido antes da desconexão                         | Quando                                                                                                             | O que o app faz                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `session.revoked` (`EventSessionRevoked`, `data.reason`)    | Logout, troca ou redefinição de senha, desativação, novo login no aparelho, reuso do token de renovação (CA-01.05) | Volta para o login                                                          |
| `session.expired` (`EventSessionExpired`, `data.expiredAt`) | Venceu o token de acesso usado no handshake (15 min)                                                               | `POST /auth/refresh` e `socket.connect()` (o navegador manda o cookie novo) |

Nos dois casos o servidor desconecta em seguida e o cliente recebe `disconnect` com motivo `io server disconnect`, no qual o Socket.IO **não** reconecta sozinho. Se o evento se perder, trate `io server disconnect` como `session.expired`: tente renovar; se a renovação falhar, login. As outras quedas (rede, servidor reiniciando) reconectam sozinhas.

A revogação chega pelo evento interno `auth.sessions_revoked` (`AuthEvents`), emitido depois do commit: o socket cai na hora, junto com o HTTP.

### Eventos (contrato para o app)

- Nome do evento no Socket.IO = `type` (ex.: `order.created`, spec 04). Envelope de todo evento de unidade ou estação: `{ type, organizationId, unitId, occurredAt, version, data }` (seção 10).
- Cada evento é um schema zod publicado no `openapi.json` como `Event…` (RN-01.10). Os eventos de negócio entram com as specs 03, 04 e 05; nesta fase só existem `EventSessionRevoked` e `EventSessionExpired` (eventos da sessão, sem unidade nem versão).
- **RN-01.05:** ao conectar e a cada reconexão, o app primeiro busca o estado atual por REST (comandas abertas, fila da estação) e só depois aplica eventos; eventos guardados durante a busca são aplicados em seguida. Eventos perdidos na desconexão nunca são necessários: o servidor não reenvia nada (sem connection state recovery).
- O app ignora evento com `version` menor ou igual à do registro que já tem (o REST pode ter trazido um estado mais novo que o evento).

### Emitir eventos (módulos das specs 03 a 05)

```ts
export const OrderCreated = defineRealtimeEvent('EventOrderCreated', 'order.created', OrderSchema);
// em src/openapi/contract-schemas.ts: OrderCreated.schema

await this.prisma.transaction(async (tx) => {
  const order = await tx.order.create({ ... });
  this.realtime.emitToUnit(OrderCreated, { unitId: order.unitId, version: order.version, data: order });
  this.realtime.emitToStation(stationId, OrderCreated, { unitId: order.unitId, version: order.version, data: soDaEstacao });
});
```

- `RealtimeService` (importe o `RealtimeModule`) monta o envelope com a organização do contexto (nunca do chamador) e o valida com o schema na hora da chamada: payload inválido falha a ação e desfaz a transação.
- O envio acontece **só depois do commit** (`PrismaService.afterCommit`): evento de transação desfeita nunca sai. Fora de transação, sai na hora. O `unitId` e o `stationId` têm de vir de registros lidos pelo cliente filtrado da organização.
- **Uma instância:** as salas ficam na memória do processo (adapter padrão do Socket.IO), como o `auth.sessions_revoked` e o limite por IP. Mais de uma instância exigiria um adapter compartilhado (ex.: `@socket.io/postgres-adapter`); sticky session continua desnecessária, porque não há polling.

### Testar à mão

```bash
pnpm dev
curl -c jar.txt -H 'X-Device-Id: 0192f000-0000-7000-8000-000000000001' -H 'content-type: application/json' \
  -d '{"email":"dono@varal.local","password":"varal12345"}' http://localhost:3000/api/v1/auth/owner/login
node -e "
const { io } = require('socket.io-client');
const cookie = require('fs').readFileSync('jar.txt', 'utf8').split('\n')
  .filter((l) => l.includes('varal_at')).map((l) => l.split('\t')).map((f) => f[5] + '=' + f[6]).join('; ');
const s = io('http://localhost:3000', { path: '/ws', transports: ['websocket'],
  extraHeaders: { cookie, origin: 'http://localhost:3100' }, auth: { deviceId: '0192f000-0000-7000-8000-000000000001' } });
// a resposta de rooms.leave lista as salas do aparelho
s.on('connect', () => s.emitWithAck('rooms.leave', { room: 'unit:' + crypto.randomUUID() }).then(console.log));
s.onAny((e, p) => console.log(e, p));
s.on('connect_error', (e) => console.log('connect_error', e.data));
s.on('disconnect', (r) => console.log('disconnect', r));
"
# noutro terminal: curl -b jar.txt -X POST http://localhost:3000/api/v1/auth/logout  → session.revoked e disconnect
```

O `curl` grava os cookies `__Host-`/`__Secure-` com o prefixo `#HttpOnly_` no `jar.txt`; o filtro acima pega a linha do cookie de acesso.

## E-mail (spec 01, seção 9)

- `EmailService.enqueue(tx, mensagem, organizationId)` roda **na transação da ação**: grava `email_logs` (`queued`) e o job do pg-boss pelo mesmo `tx` do Prisma (adapter `fromPrisma` do pg-boss 12, que executa o SQL do pg-boss com `$queryRawUnsafe` na transação). Ação desfeita não envia nada; ação confirmada sempre tem o e-mail na fila.
- Os dados do job (destinatário e link com o token) vão cifrados (AES-256-GCM, chave derivada de `EMAIL_PAYLOAD_SECRET`): o banco não guarda o token em claro nem na fila. Jobs concluídos somem em 1 dia.
- Fila `email.send`: até 3 tentativas (`retryLimit: 2`) com espera crescente (30 s, depois 1 a 2 min). O worker renderiza o template (texto + HTML simples em pt-BR, com a cor da marca), envia por nodemailer e marca `sent`; a última falha marca `failed` com o erro.
- Todo e-mail diz no rodapé para não responder e onde pedir ajuda (**RN-01.21**): o colaborador é orientado a falar com o responsável pela barraca; os demais, com a equipe do Varal (`SUPPORT_CONTACT`, se definido).
- **RN-01.04:** `EmailService.usage(mês)` conta os e-mails `queued` e `sent` do mês no calendário de São Paulo (Temporal) e devolve o nível: `warning` a partir de 8.000, `critical` a partir de 10.000. No crítico, só os tipos críticos continuam (`EMAIL_CRITICALITY`; no MVP todos são convites e redefinições, portanto críticos); os demais viram `failed` sem envio. `GET /api/v1/admin/emails/usage?month=AAAA-MM` exige a sessão do admin; a permissão `emails:read` entra com o RBAC da spec 02.
- Tipos: `owner_invite`, `owner_password_reset`, `staff_password_reset`, `admin_invite`, `admin_password_reset`.
- Em desenvolvimento, as mensagens chegam no Mailpit (`http://localhost:8025`). O teste de ponta a ponta (`test/integration/email.int-spec.ts`) pede uma redefinição, lê o e-mail pela API do Mailpit e usa o link; ele é pulado se o Mailpit não estiver acessível (`MAILPIT_URL`, padrão `http://localhost:8025`).

## Jobs (pg-boss 12)

`PgBossService` sobe com a aplicação (início em segundo plano, com novas tentativas e espera crescente, para a API subir mesmo com o banco fora) e para no shutdown. Usa o schema `pgboss` e no máximo 3 conexões (as outras 7 do Varal são do pool da API). Filas criadas com `createQueue` no boot pelos módulos (`register`):

- `email.send`: envio de e-mail (acima);
- `maintenance.cleanup`: todo dia às 04:00 (São Paulo), apaga chaves de idempotência vencidas, sessões encerradas ou vencidas há mais de 30 dias, links usados ou vencidos com mais de 1 dia e contadores de login parados há 1 dia.

## Contratos (OpenAPI)

O `openapi.json` na raiz é o contrato consumido pelos apps (RN-01.09). Todo PR que muda rota, schema, enum ou evento roda `pnpm openapi` e commita o arquivo; a CI falha se ele estiver desatualizado (CA-01.11).

- Rotas: schemas zod com `.meta({ id })` viram `components.schemas`; o corpo usa `@Body({ schema })` e a resposta `@ApiOkResponse({ standardSchema })`.
- Enums de estado e eventos em tempo real que não aparecem em rotas entram em `src/openapi/contract-schemas.ts` (eventos com `defineEvent('Event…', schema)`, RN-01.10).

## Imagem

`Dockerfile` multi-stage sobre `node:26-alpine`, rodando como `node`: `docker build -t varal-web-api .`. A imagem inclui o CLI do Prisma para o `prisma migrate deploy` do deploy e o comando `dist/cli/create-platform-admin.js` ([Primeiro admin](#primeiro-admin)).
