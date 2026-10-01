# varal-web-api

API do Varal (NestJS): REST em `/api/v1` e, a partir da fase 1, WebSocket em `/ws`.

Specs e decisões do produto: [varal-docs](https://github.com/mchlima/varal-docs) (localmente em `../varal-docs`). Regras para agentes: [`AGENTS.md`](AGENTS.md).

## Stack

Node 26 (`>=26`, ver `.nvmrc`), pnpm 10, NestJS 12 (ESM, Express 5), TypeScript estrito, zod 4 (validação nativa do Nest via Standard Schema), Prisma 7.10.0 com `@prisma/adapter-pg`, PostgreSQL 17, OpenAPI 3.1 com `@nestjs/swagger`, Vitest 5 com SWC, ESLint 10 e Prettier.

## Primeiros passos

```bash
git config core.hooksPath .githooks          # uma vez por clone (bloqueio da main)
docker compose -f ../varal-infra/dev/compose.yml up -d   # Postgres de desenvolvimento (varal-dev-db)
scripts/worktree.sh new feat/minha-tarefa    # worktree com porta, .env.local, dependências e banco próprios
```

Sem o script, num checkout já existente: `pnpm install`, copie `.env.example` para `.env` e ajuste.

## Comandos

| Comando                             | O que faz                                                                |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `pnpm install`                      | Instala dependências e gera o Prisma Client em `src/generated/prisma`    |
| `pnpm dev`                          | Sobe a API em modo watch (porta `PORT`, padrão 3000)                     |
| `pnpm build` / `pnpm start`         | Compila para `dist/` / roda `dist/main.js`                               |
| `pnpm test`                         | Testes unitários, e2e e de integração (estes só com `DATABASE_URL_TEST`) |
| `pnpm test:watch`                   | Testes em modo watch                                                     |
| `pnpm lint`                         | ESLint com regras que usam tipos                                         |
| `pnpm format` / `pnpm format:check` | Prettier                                                                 |
| `pnpm typecheck`                    | `tsc --noEmit`                                                           |
| `pnpm openapi`                      | Gera o `openapi.json` sem subir servidor nem conectar no banco           |
| `pnpm db:migrate`                   | `prisma migrate dev` (só na máquina de desenvolvimento)                  |
| `pnpm db:deploy`                    | `prisma migrate deploy` (CI e deploy)                                    |
| `pnpm db:generate`                  | Regenera o Prisma Client (rode depois de `db:migrate`)                   |
| `pnpm db:seed`                      | Dados de exemplo, idempotente (o `scripts/worktree.sh new` já roda)      |

Saúde: `GET /api/v1/health` responde `{ "status": "ok", "db": "ok" | "unavailable" }`.

## Ambiente

Variáveis em [`.env.example`](.env.example), validadas com zod no boot (a API não sobe se estiverem erradas). Em desenvolvimento, `.env.local` e `.env` são carregados nessa ordem.

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

**Ponto de integração da fase 1b:** o guard de autenticação valida o cookie e chama `setAuthContext({ organizationId, actor, impersonatorId })` uma única vez por requisição (uma segunda chamada falha). Até lá, os testes usam `test/support/stub-auth.ts`, que lê cabeçalhos `X-Test-*`; ele nunca é importado por `src/`. Fora de HTTP (jobs, scripts, testes), use `runWithContext(systemContext({ auth }), fn)`.

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

**Teste de isolamento obrigatório** para cada recurso novo, com o kit em [`test/support/isolation-kit.ts`](test/support/isolation-kit.ts): `describeTenantIsolation('Modelo', {...})` (camada de dados) e `expectNotFoundForOtherTenant(app, {...})` (HTTP, 404).

### Erros

Todo erro sai como `{ "error": { "code", "message", "details" } }` (schema `ErrorResponse` no OpenAPI, resposta `default` de toda rota). `code` estável em inglês, `message` em pt-BR. Lance `AppError.of('NOT_FOUND')` ou, com código do módulo, `new AppError('TAB_ALREADY_CLOSED', 409, 'Esta comanda já foi fechada.')`. Validação zod vira `VALIDATION_FAILED` com `details.fields: [{ path, message }]` (mensagens do zod em pt-BR). Erros inesperados viram `INTERNAL_ERROR` sem mensagem interna em produção; a pilha vai só para o log.

### Paginação

`@Query({ schema: PaginationQuerySchema })` (`?limit=50&cursor=...`, limite 1 a 100), `pageArgs(query)` no `findMany` e `toPage(rows, limit)` → `{ data, nextCursor }`. O cursor é opaco (id UUID v7, em ordem de criação). Resposta nomeada com `pageSchema('UnitPage', UnitSchema)`.

### Idempotência

`@Idempotent()` numa rota de escrita aceita `Idempotency-Key` (UUID). A primeira requisição reserva a chave por sujeito; o handler roda numa transação ambiente (`prisma.transaction` entra nela) e a resposta é gravada nessa mesma transação. Repetição em 24 h devolve o mesmo status e corpo com `Idempotent-Replayed: true`. Mesma chave com outro corpo → 409 `IDEMPOTENCY_KEY_REUSED`; enquanto a primeira roda → 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS`. Respostas 4xx são guardadas; 5xx liberam a chave. `IdempotencyService.purgeExpired()` apaga as vencidas; o job diário que a chama entra com o pg-boss (fase 1b).

### Concorrência

`updateWithVersion(prisma.db.tab, { where: { id }, expectedVersion, data })` atualiza só se a `version` bater e a incrementa; senão 409 `VERSION_CONFLICT` com `details.currentVersion` (ou o código do módulo via `onConflict`).

### Auditoria

`auditService.record(tx, { action, entityType, entityId, before, after, metadata })` dentro da transação da ação. Ator, admin do "entrar como", aparelho, IP e `requestId` vêm do contexto; `changes` guarda só os campos alterados (`{ before, after }`), sem segredos.

### Datas

`src/common/time.ts`: `Temporal` (global no Node 26) para "agora" e dias em `America/Sao_Paulo`; `toDate`/`toInstant` convertem na borda com o `Date` do Prisma.

### Seed

`pnpm db:seed`: organização "Espetinho do Piloto" (`pilot`, código `ESPT26`), unidade "Barraca da Praça", dono `dono@varal.local`, colaboradores `ana` e `bruno` e admin `admin@varal.local`. As senhas ficam nulas: a fase 1b (argon2 e convites) define as senhas de desenvolvimento. Estações e fluxo padrão vêm com a spec 03.

## Contratos (OpenAPI)

O `openapi.json` na raiz é o contrato consumido pelos apps (RN-01.09). Todo PR que muda rota, schema, enum ou evento roda `pnpm openapi` e commita o arquivo; a CI falha se ele estiver desatualizado (CA-01.11).

- Rotas: schemas zod com `.meta({ id })` viram `components.schemas`; o corpo usa `@Body({ schema })` e a resposta `@ApiOkResponse({ standardSchema })`.
- Enums de estado e eventos em tempo real que não aparecem em rotas entram em `src/openapi/contract-schemas.ts` (eventos com `defineEvent('Event…', schema)`, RN-01.10).

## Imagem

`Dockerfile` multi-stage sobre `node:26-alpine`, rodando como `node`: `docker build -t varal-web-api .`. A imagem inclui o CLI do Prisma para o `prisma migrate deploy` do deploy.
