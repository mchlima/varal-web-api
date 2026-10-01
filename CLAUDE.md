@AGENTS.md

## Específico do Claude Code

- As instruções do projeto estão em `AGENTS.md`, importado acima. Mantenha as regras lá (via `varal-docs/docs/agents/`), não aqui, para que outros agentes também as vejam.
- O documento de escopo original, que deu origem às specs, é o Claude Doc "Varal — Escopo do MVP": https://claude.ai/code/artifact/57311d5e-1f4b-4c92-a53e-2574eade0a3a. As specs do `varal-docs` prevalecem sobre ele.
- Converse com o usuário em português do Brasil.
- Vários agentes trabalham neste repositório ao mesmo tempo. Antes de editar qualquer arquivo, crie um worktree próprio fora do repositório, em `../.worktrees/<repositório>/<nome>` (nos repositórios de código, com `scripts/worktree.sh new`), como descrito no `AGENTS.md`. Não use a ferramenta `EnterWorktree` do Claude Code: ela cria o worktree dentro do repositório, o que quebra o build dos apps. Nunca edite na raiz do repositório.
