# varal-web-api

API do Varal (NestJS): REST em `/api/v1` e, a partir da fase 1, WebSocket em `/ws`.

Specs e decisões do produto: [varal-docs](https://github.com/mchlima/varal-docs) (localmente em `../varal-docs`). Regras para agentes: [`AGENTS.md`](AGENTS.md).

## Stack

Node 22 (`>=22.12`), pnpm 10, NestJS 12 (ESM, Express 5), TypeScript estrito, zod 4 (validação nativa do Nest via Standard Schema), Prisma 7.10.0 com `@prisma/adapter-pg`, PostgreSQL 17, OpenAPI 3.1 com `@nestjs/swagger`, Vitest 5 com SWC, ESLint 10 e Prettier.

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
| `pnpm db:generate`                  | Regenera o Prisma Client                                                 |

Saúde: `GET /api/v1/health` responde `{ "status": "ok", "db": "ok" | "unavailable" }`.

## Ambiente

Variáveis em [`.env.example`](.env.example), validadas com zod no boot (a API não sobe se estiverem erradas). Em desenvolvimento, `.env.local` e `.env` são carregados nessa ordem.

## Worktrees (spec 01, seção 4.1)

```bash
scripts/worktree.sh new <tipo>/<descricao>   # .worktrees/<tipo>-<descricao>, a partir de origin/main
scripts/worktree.sh list                     # branch, PORT_OFFSET, porta e banco de cada worktree
scripts/worktree.sh remove <tipo>-<descricao>  # recusa se houver alterações sem commit; apaga só os bancos dele
```

Cada worktree recebe o menor `PORT_OFFSET` livre (1 a 99), API em `3000 + PORT_OFFSET`, e os bancos `varal_<slug>` e `varal_<slug>_test` no Postgres de desenvolvimento. O checkout principal usa `PORT_OFFSET=0`.

## Contratos (OpenAPI)

O `openapi.json` na raiz é o contrato consumido pelos apps (RN-01.09). Todo PR que muda rota, schema, enum ou evento roda `pnpm openapi` e commita o arquivo; a CI falha se ele estiver desatualizado (CA-01.11).

- Rotas: schemas zod com `.meta({ id })` viram `components.schemas`; o corpo usa `@Body({ schema })` e a resposta `@ApiOkResponse({ standardSchema })`.
- Enums de estado e eventos em tempo real que não aparecem em rotas entram em `src/openapi/contract-schemas.ts` (eventos com `defineEvent('Event…', schema)`, RN-01.10).

## Imagem

`Dockerfile` multi-stage sobre `node:22-alpine`, rodando como `node`: `docker build -t varal-web-api .`. A imagem inclui o CLI do Prisma para o `prisma migrate deploy` do deploy.
