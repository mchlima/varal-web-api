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
- `staff_unit_permissions`: chaves estrangeiras compostas com `organization_id`, para colaborador e unidade serem sempre da mesma organização. `station_ids` (array, sem FK) é validado na escrita e filtrado na leitura (seção [Configuração da unidade](#configuração-da-unidade-spec-03)).
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

Filtros de lista estendem o schema (`PaginationQuerySchema.extend({ status: ... })`). **Schemas de query não levam `.meta({ id })`:** com nome, o `@nestjs/swagger` publica só uma referência e os parâmetros (`limit`, `cursor`, filtros) somem do `openapi.json`. Sem nome, cada campo vira um parâmetro `in: query`. O teste `test/e2e/openapi-query-params.e2e-spec.ts` falha se uma rota aceitar query que o documento não publica. Os componentes `…QueryInput` antigos (ex.: `OrganizationListQueryInput`) continuam publicados por compatibilidade (`queryContractSchemas` em `src/openapi/contract-schemas.ts`); listas novas não precisam entrar ali.

### Idempotência

`@Idempotent()` numa rota de escrita aceita `Idempotency-Key` (UUID). A primeira requisição reserva a chave por sujeito; o handler roda numa transação ambiente (`prisma.transaction` entra nela) e a resposta é gravada nessa mesma transação. Repetição em 24 h devolve o mesmo status e corpo com `Idempotent-Replayed: true`. Mesma chave com outro corpo → 409 `IDEMPOTENCY_KEY_REUSED`; enquanto a primeira roda → 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS`. Respostas 4xx são guardadas; 5xx liberam a chave. `IdempotencyService.purgeExpired()` apaga as vencidas, chamada pelo job diário de limpeza (seção Jobs).

### Concorrência

`updateWithVersion(prisma.db.tab, { where: { id }, expectedVersion, data })` atualiza só se a `version` bater e a incrementa; senão 409 `VERSION_CONFLICT` com `details.currentVersion` (ou o código do módulo via `onConflict`).

### Auditoria

`auditService.record(tx, { action, entityType, entityId, before, after, metadata })` dentro da transação da ação. Ator, admin e sessão do "entrar como" (`impersonator_id`, `impersonation_id`), aparelho, IP e `requestId` vêm do contexto; `changes` guarda só os campos alterados (`{ before, after }`), sem segredos.

### Datas

`src/common/time.ts`: `Temporal` (global no Node 26) para "agora" e dias em `America/Sao_Paulo`; `toDate`/`toInstant` convertem na borda com o `Date` do Prisma.

### Seed

`pnpm db:seed`: organização "Espetinho do Piloto" (`pilot`, código `ESPT26`), unidade "Barraca da Praça" com o template padrão (Balcão, Cozinha, Balcão de entrega; Recebido → Preparando → Pronto → Entregue) e um cardápio de espetos (Espetos com "Ponto da carne" obrigatório, "Acompanhamentos" e "Retirar"; Porções; Bebidas no Balcão de entrega), dono `dono@varal.local`, colaboradores `ana` (Balcão e Balcão de entrega, opera caixa) e `bruno` (Cozinha) e admin `admin@varal.local` com o papel Super admin.

**Senha de desenvolvimento `varal12345`** para o dono, os dois colaboradores e o admin. Só existe no seed, que se recusa a rodar com `NODE_ENV=production`; ela é gravada apenas enquanto a senha está vazia, então uma senha trocada localmente sobrevive a um novo seed.

```bash
# Login do dono com curl (cookies em jar.txt); o X-Device-Id é um UUID qualquer do aparelho
curl -c jar.txt -H 'X-Device-Id: 0192f000-0000-7000-8000-000000000001' -H 'content-type: application/json' \
  -d '{"email":"dono@varal.local","password":"varal12345"}' http://localhost:3000/api/v1/auth/owner/login
curl -b jar.txt http://localhost:3000/api/v1/auth/me
```

## Primeiro admin

O primeiro acesso ao admin em produção é criado por linha de comando (depois, os usuários são convidados pela tela do admin, `POST /admin/users`):

```bash
# Produção (VPS): dentro do container da API, que já tem DATABASE_URL, ADMIN_URL e o SMTP no ambiente
docker exec varal-api node dist/cli/create-platform-admin.js --name "Nome da Pessoa" --email pessoa@exemplo.com

# Desenvolvimento (banco do worktree, e-mail no Mailpit em http://localhost:8025)
pnpm admin:create -- --name "Nome da Pessoa" --email pessoa@exemplo.com [--role "Suporte"]
```

- Valida nome e e-mail (guardado em minúsculas) e recusa, com código de saída 1, se já existir admin com o e-mail; argumentos inválidos saem com 2 e `--help` mostra o uso.
- Numa transação: cria o `platform_admin` ativo e sem senha, gera o convite (7 dias, seção 7.4), enfileira o e-mail `admin_invite` e grava a auditoria `platform_admin.created` com ator `system` (o `actor_type` que jobs e scripts já usam), `metadata.source = "cli"` e `request_id` `cli-<uuid>`.
- **Quem envia o e-mail é o worker da API em execução** (fila `email.send`): o comando sobe só um contexto enxuto do Nest com o pg-boss em modo produtor (`PG_BOSS_WORKERS = false`: sem workers, sem cron), enfileira e encerra. Em produção, rodando com `docker exec` no `varal-api`, o e-mail sai pelo worker do próprio container; em desenvolvimento, deixe o `pnpm dev` rodando para o convite chegar ao Mailpit.
- A saída nunca mostra o token nem o link, só `Convite enviado para <email>`. Se o convite vencer antes do primeiro acesso, use "Esqueci a senha" na tela de login do admin.
- **Papel (RBAC, spec 02):** sem `--role`, o admin recebe **Super admin** se ainda não houver nenhum Super admin ativo (o primeiro admin; RN-02.05 exige pelo menos um); senão fica sem papel, para receber um na tela de usuários. `--role "Nome"` escolhe o papel pelo nome (sem diferenciar maiúsculas); papel inexistente sai com 1 sem criar nada. A migration do RBAC deu Super admin aos admins que já existiam sem papel. O comando também serve para recuperar o acesso se todos os Super admin forem perdidos (desativar o último é recusado pela API, mas o banco pode ser mexido à mão).

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
- RBAC do admin (permissões por rota) e "entrar como" (`sessions.impersonation_id`, `impersonatorId` no contexto): seção [Admin da plataforma](#admin-da-plataforma-spec-02).

**Convite e redefinição (seção 7.4).** `PasswordTokenService`: 32 bytes aleatórios, só o hash no banco, uso único; gerar um novo invalida os anteriores do mesmo tipo; convite 7 dias, redefinição 1 h; **RN-01.02** no máximo 3 links de redefinição por usuário por hora. `PasswordLinkService` gera o link `{PANEL_URL|ADMIN_URL}/definir-senha#token=...&tipo=convite|redefinicao` (o token vai no fragmento, que o navegador não envia a servidores nem em `Referer`) e enfileira o e-mail:

- `issueOwnerInvite(tx, ownerId)`: chamado pelo admin ao criar a organização (fase 3, RN-02.09), na mesma transação;
- `requestOwnerPasswordReset(email)` / `requestAdminPasswordReset(email)`: "Esqueci a senha", sempre a mesma resposta e pelo menos 400 ms, exista ou não o e-mail (**RN-01.03**);
- `issueStaffPasswordReset(staffMemberId, { sendEmail })`: redefinição do colaborador pelo dono (RN-03.18; a rota fica para a spec 03); devolve o link para copiar ou mandar por WhatsApp;
- `issueAdminInvite(tx, adminId)` / `issueAdminPasswordReset(tx, adminId)`: convite e redefinição de admin pela tela de usuários (spec 02).

## Admin da plataforma (spec 02)

Rotas em [`src/admin`](src/admin), todas sob `/api/v1/admin` e com a sessão do admin (CA-01.04). O lado do dono fica em [`src/announcements`](src/announcements) e [`src/support-access`](src/support-access); a troca do link do "entrar como" em [`src/auth`](src/auth).

| Rotas                                                                                                                                                                   | Permissão                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `GET /permissions` (catálogo)                                                                                                                                           | qualquer admin                               |
| `GET /roles`                                                                                                                                                            | `admin.roles:manage` ou `admin.users:manage` |
| `POST /roles`, `PATCH /roles/{id}`, `DELETE /roles/{id}`                                                                                                                | `admin.roles:manage`                         |
| `GET /users`, `GET /users/{id}`, `POST /users` (convite), `PATCH /users/{id}`, `PUT /users/{id}/roles`, `PUT /users/{id}/permissions`, `POST /users/{id}/password-link` | `admin.users:manage`                         |
| `GET /organizations` (busca, situação, paginação), `GET /organizations/{id}`                                                                                            | `organizations:read`                         |
| `POST /organizations`                                                                                                                                                   | `organizations:create`                       |
| `PATCH /organizations/{id}` (nome, nome e e-mail do dono), `POST /organizations/{id}/owner-invite`                                                                      | `organizations:update`                       |
| `POST /organizations/{id}/suspend`, `/reactivate`                                                                                                                       | `organizations:suspend`                      |
| `PUT /organizations/{id}/subscription-status`                                                                                                                           | `subscriptions:update`                       |
| `GET /announcements`, `GET /announcements/{id}`                                                                                                                         | `announcements:read`                         |
| `POST /announcements`, `PATCH /announcements/{id}`, `POST /announcements/{id}/publish`, `/archive`                                                                      | `announcements:manage`                       |
| `GET /metrics/overview`, `GET /metrics/organizations`                                                                                                                   | `metrics:read`                               |
| `POST /impersonations`, `GET /impersonations`                                                                                                                           | `impersonation:use`                          |
| `POST /impersonations/{id}/end`                                                                                                                                         | o próprio admin da sessão                    |
| `GET /emails`, `GET /emails/usage`                                                                                                                                      | `emails:read`                                |
| `GET /audit-logs`                                                                                                                                                       | `audit:read`                                 |

No app dos clientes (só o dono, com o `OwnerOnly()` da spec 03; colaborador recebe 403): `GET /api/v1/announcements/unread`, `POST /api/v1/announcements/{id}/read` e `GET /api/v1/support-access`. E a troca do link do "entrar como": `POST /api/v1/auth/impersonation`.

### RBAC (seção 3)

- **Catálogo** fixo em [`src/admin/rbac/permissions.ts`](src/admin/rbac/permissions.ts), publicado no OpenAPI como o enum `Permission` (RN-02.03). Cada rota declara `@RequirePermission('x', 'y')` (qualquer uma delas) ou `@AnyAdmin()`; o `PermissionGuard` lê do banco, a cada requisição, as permissões efetivas (papéis + avulsas, RN-02.02/RN-02.08) e responde `403 FORBIDDEN` com `details.requiredPermissions`. O OpenAPI leva a lista em `x-permissions` de cada operação. Um teste (`test/e2e/admin-permissions.e2e-spec.ts`) falha se alguma rota sob `/admin` (fora `/admin/auth`) não declarar permissão; outro (`test/integration/admin-rbac.int-spec.ts`) percorre todas as rotas com cada papel do sistema e confere o 403.
- **Papéis do sistema** criados pela migration (idempotente; o seed recria os que faltarem), identificados por `roles.system_key`: `super_admin`, `support`, `finance`, `read_only` (tabela da seção 3.2). **Super admin** não tem linhas em `role_permissions`: tem sempre o catálogo inteiro, inclusive permissões criadas depois, e não pode ser editado. Os outros papéis do sistema mantêm o nome, mas podem ter descrição e permissões alteradas; nenhum papel do sistema é excluído (RN-02.04). Papéis personalizados: criar, renomear, alterar e excluir quando ninguém os tem (RN-02.07).
- **RN-02.05:** desativar o último Super admin ativo ou tirar o papel dele dá `409 LAST_SUPER_ADMIN`; essas mudanças travam a linha do papel Super admin (`FOR UPDATE`) para duas não passarem juntas. **RN-02.06:** ninguém muda os próprios papéis, permissões avulsas ou situação (`403 CANNOT_CHANGE_OWN_ACCESS`).
- Desativar um usuário do admin encerra as sessões dele na hora. `GET /admin/auth/me` devolve os papéis e as permissões efetivas, para o app esconder o que não pode.
- As rotas de `/admin/auth` (login, sessão, senha) não pedem permissão: são a própria sessão.

### Organizações (seção 4)

- **Criar** (`POST /organizations`, RN-02.09): numa transação, organização com `access_code` livre, primeira unidade, dono sem senha, convite do dono (`issueOwnerInvite`, e-mail `owner_invite`) e auditoria (`organization.created`, `unit.created`, `unit.template_applied`, `user.created`). E-mail de dono já existente: `409 OWNER_EMAIL_TAKEN` (RN-02.10). Situação inicial `active` (ou `pilot`, no corpo).
- **Template padrão da primeira unidade:** na mesma transação, logo depois de criar a unidade, o admin chama `UnitTemplateService.applyDefaultTemplate(tx, { organizationId, unitId })` da spec 03 (`UnitsModule`, importado pelo `AdminModule`) com a transação do cliente sem filtro: a unidade nasce com Balcão, Cozinha e Balcão de entrega e as etapas Recebido → Preparando → Pronto → Entregue (`unit.template_applied` na auditoria). Uma falha desfaz a criação inteira.
- **Situação** (RN-02.11/RN-02.12): `suspend` (de `pilot`/`active`), `reactivate` (de `suspended`/`canceled` para `active` ou `pilot`) e `subscription-status` (qualquer outra), sempre com motivo, que vai para a auditoria (`metadata.reason`) e, em `suspended`/`canceled`, para `organizations.suspended_reason`, que o `GET /auth/me` do painel devolve para a faixa. Transição inválida: `409 INVALID_STATUS_TRANSITION`. Abrir turno (spec 04) chama `assertCanOpenShift` de [`src/common/subscription.ts`](src/common/subscription.ts): `409 ORGANIZATION_SUSPENDED` / `ORGANIZATION_CANCELED` (CA-02.05).
- **Detalhe**: situação, dono com a situação do convite (`pending`, `expired`, `accepted`), unidades, colaboradores ativos, últimos turnos (vazio até a spec 04), último acesso (maior `sessions.last_used_at` fora do "entrar como") e comunicados não lidos pelo dono.
- Trocar o e-mail de um dono que ainda não aceitou o convite manda um convite novo para o e-mail novo.

### Comunicados (seção 5)

Criados como rascunho; `POST /publish` publica agora ou, com `publishAt` no futuro, agenda; publicado só pode ser arquivado (RN-02.15). Para o dono, um agendado aparece **a partir de `publish_at`**, mesmo antes do job `admin.minutely` marcar `published` (CA-02.06). Públicos: todos, por situação (avaliada no momento da leitura) ou organizações escolhidas (`announcement_targets`). A leitura (`announcement_reads`, uma por dono) é dado de tenant; comunicado de outro público responde 404. Num "entrar como" a leitura não é registrada.

### Métricas (seção 6)

Período em dias de Brasília (padrão: últimos 30). Organizações por situação e último acesso já vêm dos dados atuais; turnos, comandas, valor vendido e ticket médio ficam em zero até as specs 04 a 06: o único lugar a preencher é `MetricsService.operationalTotals`.

### "Entrar como" (seção 7)

Decisão do dono do projeto para o MVP: acesso total (RN-02.18), com `impersonation:use`, sempre auditado e listado ao dono. Como a API tem host próprio e os cookies do app e do admin ficam no mesmo host (distinguidos pelo nome, spec 01, seção 4), o fluxo é:

1. O admin chama `POST /admin/impersonations` com a organização e o motivo (mínimo 10 caracteres). A API grava `impersonation_sessions` (60 min, RN-02.17), audita `impersonation.started` e devolve `handoffUrl` = `{PANEL_URL}/entrar-como#token=...`: um token de uso único, válido por 2 minutos, guardado só como hash, no fragmento (não vai para logs nem `Referer`).
2. O app do admin abre esse link numa nova aba. A página `/entrar-como` do painel chama `POST /api/v1/auth/impersonation` com o token e o próprio `X-Device-Id`. O navegador manda junto o cookie de acesso do admin (mesmo host da API): **a API exige a sessão do mesmo admin que abriu o acesso**, então um link vazado não funciona em outro navegador (`401` sem sessão do admin, `400 INVALID_IMPERSONATION_TOKEN` para link usado, vencido ou de outro admin).
3. A API abre uma sessão do app **como o dono** (`sessions.impersonation_id`), com os cookies do app, que termina junto com o "entrar como": a renovação nunca passa de `expires_at` e o token de acesso também não (CA-02.08). Cada requisição dessa sessão leva `impersonatorId` e `impersonationId` no contexto: a auditoria grava o dono como ator, o admin em `impersonator_id` e a sessão em `impersonation_id` (RN-02.20). O `GET /auth/me` traz `impersonation` (`adminName`, `expiresAt`) para a faixa fixa (RN-02.19).
4. Termina por `POST /admin/impersonations/{id}/end` (só o admin que abriu), pelo "Encerrar acesso" do painel (`POST /auth/logout` da sessão do "entrar como") ou por tempo; as sessões caem na hora e o socket recebe `session.revoked` (`impersonation_ended`). A sessão nunca vale no admin nem em outra organização (RN-02.21), e trocar a senha do dono é recusado (`403 NOT_ALLOWED_DURING_IMPERSONATION`).
5. O dono vê os acessos em `GET /api/v1/support-access` (admin, motivo, início e fim; RN-02.22).

### E-mails e auditoria (seção 8)

`GET /admin/emails` (tipo, situação, organização, período; com o erro) e `GET /admin/audit-logs` (organização, ator, admin do "entrar como", ação exata ou prefixo terminado em ponto, entidade, período; com as alterações), paginadas da mais nova para a mais antiga. Toda ação do admin é auditada (`role.*`, `platform_admin.*`, `organization.*`, `user.*`, `announcement.*`, `impersonation.*`).

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

| Sala                  | Quem entra (automaticamente, no handshake)                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `unit:{unitId}`       | Dono: todas as unidades **ativas** da organização. Colaborador: as unidades ativas de `staff_unit_permissions`              |
| `station:{stationId}` | Dono: todas as estações ativas das unidades ativas. Colaborador: as estações ativas de `station_ids`, só da própria unidade |

- As salas são calculadas pelo cliente do Prisma filtrado pela organização da sessão; nunca entra sala de outra organização (CA-01.02).
- **Opcional:** `socket.emitWithAck('rooms.leave', { room })` sai de uma sala (ex.: estações que o aparelho não está operando) e `rooms.join` volta a ela, conferida no servidor contra as permissões atuais. A resposta é `RealtimeRoomAck`: `{ ok: true, rooms }` ou `{ ok: false, error }` com `ROOM_FORBIDDEN` (sala inexistente, de outra organização ou sem permissão; mesma resposta nos três casos) ou `VALIDATION_FAILED`.
- Uma sala interna por sessão (`session:{id}`) serve para encerrar os sockets dela; o cliente não consegue entrar nela.
- Uma sala interna por usuário (`subject:{tipo}:{id}`) serve para reconectar todos os aparelhos dele quando o acesso muda.
- As salas são fixadas na conexão. Quando o acesso muda (spec 03: permissões do colaborador, unidade ou estação criada, ativada, desativada ou com tipo trocado), `RealtimeService.refreshAccess` manda `session.access_changed` e desconecta, depois do commit; a sessão continua válida, e o app busca `GET /auth/me` e reconecta, entrando nas salas novas.

### Desconexão

| Evento recebido antes da desconexão                                   | Quando                                                                                                             | O que o app faz                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `session.revoked` (`EventSessionRevoked`, `data.reason`)              | Logout, troca ou redefinição de senha, desativação, novo login no aparelho, reuso do token de renovação (CA-01.05) | Volta para o login                                                          |
| `session.expired` (`EventSessionExpired`, `data.expiredAt`)           | Venceu o token de acesso usado no handshake (15 min)                                                               | `POST /auth/refresh` e `socket.connect()` (o navegador manda o cookie novo) |
| `session.access_changed` (`EventSessionAccessChanged`, `data.reason`) | O acesso mudou (spec 03): `permissions_changed`, `unit_changed`, `stations_changed`                                | `GET /auth/me` e `socket.connect()`                                         |

Nos dois casos o servidor desconecta em seguida e o cliente recebe `disconnect` com motivo `io server disconnect`, no qual o Socket.IO **não** reconecta sozinho. Se o evento se perder, trate `io server disconnect` como `session.expired`: tente renovar; se a renovação falhar, login. As outras quedas (rede, servidor reiniciando) reconectam sozinhas.

A revogação chega pelo evento interno `auth.sessions_revoked` (`AuthEvents`), emitido depois do commit: o socket cai na hora, junto com o HTTP.

### Eventos (contrato para o app)

- Nome do evento no Socket.IO = `type` (ex.: `order.created`, spec 04). Envelope de todo evento de unidade ou estação: `{ type, organizationId, unitId, occurredAt, version, data }` (seção 10).
- Cada evento é um schema zod publicado no `openapi.json` como `Event…` (RN-01.10). Eventos da sessão (sem unidade nem versão): `EventSessionRevoked`, `EventSessionExpired`, `EventSessionAccessChanged`. Eventos da spec 03 na seção [Configuração da unidade](#configuração-da-unidade-spec-03); os das specs 04 e 05 entram com elas.
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
- **RN-01.04:** `EmailService.usage(mês)` conta os e-mails `queued` e `sent` do mês no calendário de São Paulo (Temporal) e devolve o nível: `warning` a partir de 8.000, `critical` a partir de 10.000. No crítico, só os tipos críticos continuam (`EMAIL_CRITICALITY`; no MVP todos são convites e redefinições, portanto críticos); os demais viram `failed` sem envio. `GET /api/v1/admin/emails/usage?month=AAAA-MM` exige a sessão do admin com `emails:read` (RBAC da spec 02).
- Tipos: `owner_invite`, `owner_password_reset`, `staff_password_reset`, `admin_invite`, `admin_password_reset`.
- Em desenvolvimento, as mensagens chegam no Mailpit (`http://localhost:8025`). O teste de ponta a ponta (`test/integration/email.int-spec.ts`) pede uma redefinição, lê o e-mail pela API do Mailpit e usa o link; ele é pulado se o Mailpit não estiver acessível (`MAILPIT_URL`, padrão `http://localhost:8025`).

## Jobs (pg-boss 12)

`PgBossService` sobe com a aplicação (início em segundo plano, com novas tentativas e espera crescente, para a API subir mesmo com o banco fora) e para no shutdown. Usa o schema `pgboss` e no máximo 3 conexões (as outras 7 do Varal são do pool da API). Filas criadas com `createQueue` no boot pelos módulos (`register`):

- `email.send`: envio de e-mail (acima);
- `maintenance.cleanup`: todo dia às 04:00 (São Paulo), apaga chaves de idempotência vencidas, sessões encerradas ou vencidas há mais de 30 dias, links usados ou vencidos com mais de 1 dia e contadores de login parados há 1 dia;
- `admin.minutely`: a cada minuto, publica os comunicados agendados que chegaram na data e marca como `expired` os "entrar como" que passaram dos 60 minutos (spec 02, abaixo).

## Contratos (OpenAPI)

O `openapi.json` na raiz é o contrato consumido pelos apps (RN-01.09). Todo PR que muda rota, schema, enum ou evento roda `pnpm openapi` e commita o arquivo; a CI falha se ele estiver desatualizado (CA-01.11).

- Rotas: schemas zod com `.meta({ id })` viram `components.schemas`; o corpo usa `@Body({ schema })` e a resposta `@ApiOkResponse({ standardSchema })`.
- Enums de estado e eventos em tempo real que não aparecem em rotas entram em `src/openapi/contract-schemas.ts` (eventos com `defineEvent('Event…', schema)`, RN-01.10).

## Configuração da unidade (spec 03)

Módulos [`src/units`](src/units) (unidades, estações, fluxo, template, roteamento, acesso), [`src/menu`](src/menu) (cardápio) e [`src/staff`](src/staff) (colaboradores e acesso da equipe). Todas as rotas exigem a sessão do app; as de configuração só aceitam o **dono** (`OwnerOnly()`: colaborador recebe 403 `FORBIDDEN`). Exceções: `GET /units/{id}/menu` (dono e colaboradores da unidade) e esgotado (dono e colaboradores com estação na unidade, RN-03.11). Id de outra organização (ou que não é UUID) é 404, como inexistente (CA-01.02). Erros do módulo no enum `SetupErrorCode`.

| Rota                                                                                                                      | O quê                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /units`, `PATCH /units/{id}`                                                                                    | Unidades (paginado); criar aplica o template; `lateAfterMinutes` de 1 a 240 (padrão 15); `version` opcional no `PATCH` |
| `GET/POST /units/{id}/stations`, `PATCH /stations/{id}`                                                                   | Estações (`counter`, `queue`), nunca apagadas, só desativadas                                                          |
| `GET/PUT /units/{id}/workflow`                                                                                            | Fluxo completo, salvo de uma vez e validado (RN-03.05 a 03.07)                                                         |
| `GET /units/{id}/menu`                                                                                                    | Cardápio em ordem, com estação de preparo resolvida e `version`                                                        |
| `POST /categories`, `PATCH /categories/{id}`, `PUT /units/{id}/categories/order`                                          | Categorias e ordenação                                                                                                 |
| `POST /products`, `PATCH /products/{id}`, `PUT /categories/{id}/products/order`                                           | Produtos (`priceCents` inteiro ≥ 0) e ordenação                                                                        |
| `POST/DELETE /products/{id}/sold-out`                                                                                     | Esgotado                                                                                                               |
| `POST /modifier-groups` (com as opções), `PATCH/DELETE /modifier-groups/{id}`, `POST /modifiers`, `PATCH /modifiers/{id}` | Modificadores                                                                                                          |
| `GET/POST /staff`, `PATCH /staff/{id}`, `PUT /staff/{id}/permissions`                                                     | Colaboradores e permissões por unidade                                                                                 |
| `POST /staff/{id}/password-reset`, `PUT /staff/{id}/password`                                                             | Link de redefinição (copiar, WhatsApp, e-mail opcional) e senha definida pelo dono                                     |
| `GET /organization/access`                                                                                                | Código, link `{PANEL_URL}/e/{code}` e QR em SVG                                                                        |

`Idempotency-Key` é aceito nas criações (`POST`) e no esgotado (feito do aparelho, pela fila offline). O link de redefinição **não** é idempotente: a resposta guardaria o token em claro.

### Decisões

- **Template padrão (RN-03.03, CA-03.01):** `UnitTemplateService.applyDefaultTemplate(tx, { organizationId, unitId })` cria Balcão (`counter`), Cozinha e Balcão de entrega (`queue`) e as etapas Recebido e Preparando (`product_station`), Pronto (`fixed_station`, Balcão de entrega) e Entregue (`none`, final). É idempotente (só aplica numa unidade sem estações nem etapas, com `SELECT … FOR UPDATE` na unidade) e aceita a transação do cliente com tenant ou do cliente da plataforma, porque toda consulta nomeia a organização. Roda na criação de unidade pelo dono (`POST /units`) e no seed.
- **Integração com a spec 02:** ao criar a organização e a primeira unidade, o admin chama `UnitTemplateService.applyDefaultTemplate(tx, { organizationId, unitId })` (exportado pelo `UnitsModule`) na mesma transação do `PlatformPrismaService`.
- **Fluxo:** `PUT` substitui o fluxo inteiro, na ordem enviada. Etapas enviadas com `id` são atualizadas no lugar; as que ficaram de fora são **arquivadas** (`archived_at`), nunca apagadas, porque itens de turnos passados apontam para elas (spec 04). O índice único `(unit_id, sort_order)` vale só para as não arquivadas. Validação pura em `validateWorkflow` (`src/units/workflow-rules.ts`): 2 a 8 etapas, só a última com `none`, `fixed_station` numa estação `queue` ativa da unidade, nomes sem repetir; os problemas voltam em `INVALID_WORKFLOW` com `details.issues` (CA-03.02). O `PUT` incrementa `units.version` primeiro (trava a linha e responde `VERSION_CONFLICT` se o app mandou `version` antiga).
- **Roteamento (RN-03.08, CA-03.04):** funções puras em `src/units/routing.ts`, para a spec 04: `resolvePrepStationId(product, category)` (a do produto, senão a da categoria), `isValidPrepStation` (estação `queue` ativa) e `stationForStage(stage, prepStationId)`. Toda categoria nova recebe a Cozinha (ou a primeira estação de fila ativa). As FKs compostas `(organization_id, unit_id, station_id)` garantem no banco que categoria, produto e etapa apontam para estação da mesma unidade.
- **Estações em uso:** uma estação usada por etapa `fixed_station`, categoria ou produto não pode ser desativada nem virar `counter` (`STATION_IN_USE`); a unidade mantém uma `counter` e uma `queue` ativas (`STATION_KIND_REQUIRED`, RN-03.04).
- **Turno aberto (RN-03.02, RN-03.07, CA-03.03):** `OpenShiftChecker` responde `false` até existirem turnos. A spec 04 troca o provider no `UnitsModule` por uma consulta em `shifts`; aí estações, fluxo e desativação da unidade passam a responder 409 `SHIFT_OPEN`. Cardápio e esgotado continuam liberados com turno aberto (RN-03.11, RN-03.12).
- **Permissões e `station_ids`:** mantido o array de `staff_unit_permissions` (contrato da spec 01), sem tabela de junção. Estações nunca são apagadas, então nenhum id fica órfão; a escrita (`PUT /staff/{id}/permissions`) só aceita estações **ativas da mesma unidade** (`INVALID_REFERENCE`), e a leitura (`/auth/me`, salas do tempo real, lista de colaboradores) mantém só as estações ativas daquela unidade (`permittedStations`). Desativar uma estação tira o acesso a ela sem reescrever as permissões; reativar devolve.
- **RN-03.16:** colaborador sem nenhuma unidade ativa não entra: com a senha certa, o login responde 403 `STAFF_WITHOUT_UNIT` (senha errada continua `INVALID_STAFF_CREDENTIALS`, nada é revelado antes da senha). Tirar todas as unidades de um colaborador encerra as sessões dele (`staff_access_removed`).
- **Mudança de permissão vale na hora (spec 01, seção 10):** o HTTP já confere as permissões no banco a cada requisição; no tempo real, `refreshAccess` reconecta os aparelhos do colaborador (`session.access_changed`). Desativar (RN-03.17), definir a senha (RN-03.19) ou tirar todas as unidades revogam as sessões (`session.revoked`).
- **Esgotado (RN-03.11):** dono ou colaborador com pelo menos uma estação ativa da unidade; repetir o mesmo estado não muda nada nem emite evento. Chega aos balcões por `product.sold_out_changed` (CA-03.05).
- **Cardápio para o colaborador (RN-03.10):** só categorias, produtos e opções ativas; esgotados aparecem com `soldOut: true`. O dono recebe tudo, com `active`.
- **Grupos de modificadores:** `required = minChoices ≥ 1` vai no cardápio; a recusa do item sem escolha (CA-03.06) é do envio do pedido (spec 04). Grupo pode ser apagado (as opções vão junto, `ON DELETE CASCADE`), porque o item guarda cópia do nome e do acréscimo (RN-04.18); opções só são desativadas. Acréscimo ≥ 0.
- **Versões:** `units.version` (configuração: unidade, estações, fluxo), `units.menu_version` (qualquer mudança no cardápio, menos esgotado) e `products.version` (toda mudança do produto, inclusive esgotado). `PATCH /units/{id}`, `PATCH /products/{id}` e `PUT /units/{id}/workflow` aceitam `version` opcional para `VERSION_CONFLICT`.
- **QR:** gerado no servidor com [`uqr`](https://github.com/unjs/uqr) (sem dependências), em SVG, correção M e margem de 4 módulos (`src/staff/access-qr.ts`).
- **Auditoria:** `unit.created|updated|template_applied`, `station.created|updated`, `workflow.updated`, `category.created|updated|reordered`, `product.created|updated|reordered|sold_out_changed`, `modifier_group.created|updated|deleted`, `modifier.created|updated`, `staff_member.created|updated|permissions_updated|password_set`, além de `auth.password_link_issued` e `auth.sessions_revoked`. Hash de senha aparece só como `[redacted]`.

### Eventos (sala `unit:{unitId}`, depois do commit)

| Evento                     | Schema                       | Quando                               | `data` / `version`                          |
| -------------------------- | ---------------------------- | ------------------------------------ | ------------------------------------------- |
| `product.sold_out_changed` | `EventProductSoldOutChanged` | Esgotado marcado ou desmarcado       | `{ productId, soldOut }`; versão do produto |
| `menu.updated`             | `EventMenuUpdated`           | Qualquer outra mudança no cardápio   | `{ unitId, version }`; versão do cardápio   |
| `unit.config_updated`      | `EventUnitConfigUpdated`     | Unidade, estações ou fluxo alterados | `{ unitId, version }`; versão da unidade    |

`unit.config_updated` (spec 03, seção 8) avisa o app para recarregar `/auth/me` (tempo de atraso, estações) e a tela de configuração.

## Imagem

`Dockerfile` multi-stage sobre `node:26-alpine`, rodando como `node`: `docker build -t varal-web-api .`. A imagem inclui o CLI do Prisma para o `prisma migrate deploy` do deploy e o comando `dist/cli/create-platform-admin.js` ([Primeiro admin](#primeiro-admin)).
