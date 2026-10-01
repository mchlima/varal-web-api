# AGENTS.md

Instruções para agentes de código (Claude Code, Codex, Cursor e similares) que trabalham no `varal-web-api`.

> Arquivo gerado a partir do [varal-docs](https://github.com/mchlima/varal-docs/tree/main/docs/agents) (`docs/agents/varal-web-api.md` + `docs/agents/regras-comuns.md`). Não edite aqui: mude no varal-docs e regenere com `scripts/build-agents.sh varal-web-api`.

## Este repositório: varal-web-api

API do Varal: NestJS com REST em `/api/v1` e WebSocket (Socket.IO) em `/ws`, PostgreSQL, migrations e o `openapi.json` consumido pelos apps. Specs principais: 01 a 07.

Stack: Node 22, TypeScript estrito, NestJS, PostgreSQL 17, Prisma, zod, pg-boss para filas, nodemailer com SMTP Locaweb.

### Comandos

Ainda não há código. Quando o projeto for criado, registre aqui os comandos de instalação, desenvolvimento, testes, lint, migrations, geração do OpenAPI e build, e mantenha esta seção atualizada.

### Regras que não podem quebrar

1. **Isolamento entre organizações.** Toda tabela de dados de cliente tem `organization_id`. A organização vem do token, nunca de parâmetro do cliente. Todo recurso novo ganha um teste que prova que a organização A não lê nem altera dados da B.
2. **Auditoria.** Toda ação que cria, altera, cancela ou estorna dado relevante grava em `audit_logs` na mesma transação, com ator, aparelho e, em "entrar como", o admin responsável.
3. **Idempotência.** Escritas operacionais aceitam `Idempotency-Key`; reenviar a mesma requisição nunca duplica pedido, pagamento ou movimento.
4. **Concorrência.** Mudanças de etapa e cancelamentos conferem a `version` do registro e respondem 409 se outro aparelho mudou antes.
5. **Contextos separados.** Sessões do app dos clientes e do admin nunca são aceitas uma no lugar da outra.
6. **Valores copiados no pedido.** O item guarda nome e preço do momento da venda; relatórios nunca leem o preço atual do cardápio.

### Contratos

- Todo PR que muda rota, schema, enum, permissão ou evento em tempo real regenera e commita o `openapi.json` (spec 01, RN-01.09 e RN-01.10). A CI recusa o PR se o arquivo estiver desatualizado.
- Prefira mudanças compatíveis (só adicionar). Mudança incompatível exige PRs coordenados nos apps e `BREAKING CHANGE` no commit.

### Banco e migrations

- No máximo uma migration por PR. Se a `main` ganhou migrations depois que você criou a sua, refaça a sua em cima delas antes do PR.
- Cada worktree usa o próprio banco `varal_<slug>` no Postgres de desenvolvimento do `varal-infra`. Nunca rode migrations ou seeds no banco de outro worktree.

### Ambiente

Porta da API: `3000 + PORT_OFFSET` (spec 01, seção 4.1).

Escopos de commit adicionais: `db`, `openapi`, `deps`.

## O projeto Varal

Varal é um SaaS de assinatura mensal para barracas de feirinha (espetos, pastéis, tapiocas). Cada colaborador usa o próprio celular como estação de trabalho: o balcão registra o pedido e ele cai direto na tela da cozinha, em tempo real. O sistema cobre comandas, pagamentos registrados, caixa, fiado e relatórios, além de um admin para a equipe do Varal. Piloto: um vendedor de espetos de churrasco.

### Repositórios

| Repositório | Conteúdo |
| --- | --- |
| [`varal-docs`](https://github.com/mchlima/varal-docs) | Specs, glossário, decisões e estas regras comuns |
| [`varal-web-api`](https://github.com/mchlima/varal-web-api) | API NestJS (REST `/api/v1` e WebSocket `/ws`), banco e migrations, `openapi.json` |
| [`varal-panel-web`](https://github.com/mchlima/varal-panel-web) | App Nuxt dos clientes (PWA): balcão, estações, caixa, painel do dono |
| [`varal-admin-web`](https://github.com/mchlima/varal-admin-web) | App Nuxt do admin da plataforma |
| [`varal-infra`](https://github.com/mchlima/varal-infra) | Docker Compose de produção, NGINX, Postgres de desenvolvimento |

Localmente, os repositórios ficam lado a lado numa pasta comum (`varal/varal-docs`, `varal/varal-web-api`…). Use os caminhos relativos `../varal-docs` etc. para ler os vizinhos; nunca edite um repositório vizinho a partir de outro.

## Specs: a fonte da verdade

- Todas as regras de produto estão nas specs do `varal-docs` ([`docs/specs/`](https://github.com/mchlima/varal-docs/tree/main/docs/specs), localmente `../varal-docs/docs/specs/`). Leia o README das specs (convenções e glossário) e a spec do módulo antes de implementar qualquer coisa.
- Regras de negócio têm id `RN-XX.YY` e critérios de aceite `CA-XX.YY`. Cite os ids nos testes, nos comentários que explicam uma regra e nas mensagens de commit.
- Cada critério de aceite implementado tem pelo menos um teste automatizado.
- Itens marcados **(proposta)** ainda não foram confirmados pelo dono do projeto. Não trate como decisão definitiva; se a implementação depender de um deles, pergunte.
- Se o comportamento precisar divergir da spec, abra também um PR no `varal-docs` atualizando a spec, e cite um PR no outro. Nunca deixe código e spec contando histórias diferentes.
- Não use frameworks de planejamento externos (como GSD). Planos e specs são arquivos markdown no `varal-docs`.

## Contratos entre repositórios

- A API é a fonte única dos contratos. O `varal-web-api` mantém o `openapi.json` commitado, com rotas, schemas, enums de estado e payloads dos eventos em tempo real (spec 01, seção 3.1).
- Os apps geram tipos e cliente HTTP a partir do `openapi.json` (`pnpm gen:api`). Tipos gerados nunca são editados à mão, e nenhum enum ou formato de evento é redefinido manualmente num app.
- Mudanças na API são compatíveis com versões anteriores sempre que possível (só adicionar). Mudança incompatível exige PRs coordenados e o rodapé `BREAKING CHANGE`.

### Mudanças que atravessam repositórios

- Use **o mesmo nome de branch** em todos os repositórios afetados (ex.: `feat/reabrir-comanda` no `varal-docs`, no `varal-web-api` e no `varal-panel-web`).
- Cada PR lista, na descrição, os PRs relacionados nos outros repositórios.
- Ordem de merge: spec (`varal-docs`) → API (`varal-web-api`) → apps (`varal-panel-web`, `varal-admin-web`) → infra (`varal-infra`), quando houver.
- Um agente trabalha em um repositório por vez; se a tarefa exigir mudar outro repositório, abra o worktree e a branch lá também, seguindo as mesmas regras.

## Convenções de código

- **Idioma:**
  - **Inglês** em toda a codebase: variáveis, funções, classes, componentes, arquivos, tabelas e colunas, rotas da API (`/api/v1/tabs`), eventos, enums e chaves de permissão. Use os nomes do glossário das specs (ex.: comanda = `Tab`, turno = `Shift`, fiado = `on_credit`).
  - **Português do Brasil** em tudo que o usuário vê: textos da interface, mensagens de erro exibidas e **rotas do front** (`/balcao`, `/painel/cardapio`). Specs e mensagens de commit também em português.
  - No Nuxt, os arquivos em `pages/` seguem o nome da rota em português (`pages/balcao.vue`), por ser o roteamento por arquivo. É a única exceção ao inglês; componentes, composables e stores continuam em inglês.
- **TypeScript estrito.** Sem `any` sem justificativa.
- **Dinheiro:** sempre inteiro em centavos, campos com sufixo `_cents` / `Cents`. Nunca `float` ou `decimal` em JavaScript.
- **Datas:** `timestamptz` em UTC no banco; exibição em `America/Sao_Paulo`.
- **IDs:** UUID v7.
- **Nada operacional é apagado:** comandas, pedidos, itens, pagamentos e movimentos de caixa são cancelados ou estornados, nunca removidos. Cadastros são desativados.
- **Segredos** só em variáveis de ambiente. Nunca commitar `.env`, credenciais de SMTP ou chaves.

## Credenciais locais

Credenciais de infraestrutura (VPS, PostgreSQL de produção e outras) ficam **só na máquina de desenvolvimento**, fora de qualquer repositório:

- Pasta: `~/.config/varal/credentials/` (permissão `700`, arquivos `600`).
- Comece pelo `README.md` da pasta: ele lista cada arquivo `.env`, o que contém e o nome das variáveis.
- Carregue as variáveis num subshell, sem imprimir os valores: `( set -a; . ~/.config/varal/credentials/postgres.env; set +a; <comando> )`.
- **Nunca** copie valores dessa pasta para repositórios, commits, PRs, issues, logs, memória do agente ou mensagens, e nunca os imprima (`cat`, `echo`, `env`).
- Ações no VPS ou no banco de produção só com pedido explícito do usuário.
- Se faltar uma credencial, peça ao usuário; não invente nem procure em outros lugares.

## Vários agentes ao mesmo tempo

Cada repositório é trabalhado por vários agentes em paralelo. Para que um não atrapalhe o outro:

### Uma branch por assunto, um agente por branch

- Cada agente desenvolve na **branch do assunto em que está trabalhando** (ex.: `feat/fechamento-de-caixa`), nunca na `main` e nunca na branch de outro agente.
- Uma branch trata de **um único assunto**. Se aparecer algo de outro assunto no meio do trabalho, anote para o usuário ou abra outra branch; não misture no mesmo PR.
- Assuntos diferentes = branches diferentes, mesmo que o mesmo agente trabalhe em ambos.

### Cada agente no seu worktree

- **O checkout principal (a raiz do repositório) fica sempre na `main`, limpo.** Ninguém edita arquivos nem troca de branch nele; ele só serve de base.
- Cada tarefa roda num **git worktree próprio**, dentro de `.worktrees/` (ignorada pelo git), com a sua branch:
  ```
  git fetch origin && git worktree add .worktrees/<tipo>-<descricao> -b <tipo>/<descricao> origin/main
  ```
  Nos repositórios de código, prefira `scripts/worktree.sh new <tipo>/<descricao>`, que também prepara portas e banco (spec 01, seção 4.1).
- Trabalhe, rode comandos e faça commits **somente dentro do seu worktree**. Nunca edite arquivos de outro worktree nem da raiz.
- Ao terminar (PR aceito ou tarefa abandonada), remova o worktree (`scripts/worktree.sh remove <nome>` ou `git worktree remove .worktrees/<nome>`).

### Antes de começar

- Rode `git worktree list` para ver as branches em andamento. Não pegue uma tarefa ou módulo que já tenha branch aberta; se precisar mexer no mesmo módulo, combine com o usuário.
- Prefira tarefas pequenas e de um módulo só. PRs pequenos reduzem conflito.

### Comandos proibidos fora do seu worktree

Estes comandos afetam o trabalho de outros agentes e só podem ser usados dentro do seu próprio worktree, nunca na raiz:
`git switch`/`git checkout` de branch, `git stash`, `git reset --hard`, `git clean`, `git rebase`, `git restore` em massa, `rm -rf` em pastas do projeto.

Também é proibido: apagar ou mover worktrees de outros, apagar branches que não são suas, `git push --force` em branch que não é sua, e alterar a configuração global do git.

### Ambiente isolado por worktree

Cada worktree roda o próprio ambiente sem disputar portas nem banco com os outros (spec 01, seção 4.1): portas definidas pelo `PORT_OFFSET` no `.env.local` do worktree e, na API, banco próprio no Postgres de desenvolvimento compartilhado. Nunca rode migrations, seeds ou `docker compose down -v` apontando para o banco ou o projeto de outro worktree.

## Commits e branches

### Fluxo de branches

- **Nada vai direto para a `main`.** Nem commit, nem push, nem merge local. Toda mudança nasce numa branch de trabalho e entra na `main` por pull request.
- **Nome da branch:** `<tipo>/<descricao-curta>`, com o mesmo `tipo` do Conventional Commits e descrição em minúsculas com hífens. Ex.: `feat/reabrir-comanda`, `fix/troco-em-dinheiro`, `docs/spec-fiado`.
- O PR vai da branch de trabalho para a `main`, com título no formato Conventional Commits e descrição com o que mudou, as regras e critérios de aceite cobertos (`RN-XX.YY`, `CA-XX.YY`), como testar e os PRs relacionados em outros repositórios.
- Não faça commit, push nem abra PR sem pedido explícito.

### Bloqueio da main

Como o plano gratuito do GitHub não protege branches em repositórios privados, o bloqueio é feito localmente, em duas camadas presentes em todos os repositórios:

- **Git hooks** em `.githooks/`: `pre-commit` recusa commit na `main` e `pre-push` recusa push para a `main`. Ative uma vez por clone com `git config core.hooksPath .githooks` (vale para todos os worktrees daquele clone). O `scripts/worktree.sh` dos repositórios de código confere isso.
- **Hook do Claude Code** em `.claude/settings.json` (`.claude/hooks/guard-main.py`): antes de executar, recusa `git commit`, `merge`, `rebase`, `cherry-pick`, `revert` e `am` na `main`, push para a `main` e qualquer `--no-verify`.
- **Nunca** use `--no-verify`, nunca desative ou altere os hooks para contornar o bloqueio, e nunca mude `core.hooksPath`. Se um hook bloquear algo legítimo, pare e fale com o usuário.

### Mensagens de commit

Todo commit segue o [Conventional Commits 1.0.0](https://www.conventionalcommits.org/pt-br/v1.0.0/):

```
<tipo>(<escopo opcional>): <descrição>

<corpo opcional>

<rodapés opcionais>
```

- **Tipos:** `feat` (funcionalidade), `fix` (correção), `docs` (documentação e specs), `refactor`, `test`, `perf`, `style` (formatação, sem mudar comportamento), `build` (dependências, empacotamento), `ci`, `chore` (manutenção).
- **Escopo:** o módulo afetado, em inglês e minúsculas: `auth`, `tenancy`, `audit`, `email`, `realtime`, `rbac`, `organizations`, `announcements`, `metrics`, `impersonation`, `units`, `workflow`, `menu`, `staff`, `shifts`, `tabs`, `orders`, `cash`, `credit`, `reports`, `ui`. Cada repositório pode acrescentar os seus (ver a seção específica dele).
- **Descrição:** em português, no imperativo, minúscula no início, sem ponto final, até cerca de 72 caracteres. Cite a regra quando houver: `feat(tabs): permite reabrir comanda em fechamento (RN-04.12)`.
- **Mudança incompatível:** `!` depois do tipo/escopo e rodapé `BREAKING CHANGE: <explicação>`.
- Um commit por mudança coerente.
