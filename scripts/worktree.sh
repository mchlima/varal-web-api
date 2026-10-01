#!/usr/bin/env bash
# Worktrees isolados para vários agentes em paralelo (spec 01, seção 4.1: RN-01.06 a RN-01.08 e RN-01.13).
#
#   scripts/worktree.sh new <tipo>/<descricao>   cria .worktrees/<tipo>-<descricao> a partir de origin/main,
#                                                com PORT_OFFSET livre, .env.local, dependências, bancos e migrations
#   scripts/worktree.sh list                     lista worktrees com branch, PORT_OFFSET, porta e banco
#   scripts/worktree.sh remove <nome>            remove o worktree (recusa se houver alterações sem commit)
#                                                e apaga só os bancos dele
#
# O checkout principal usa PORT_OFFSET=0 e nunca é alterado por este script.
# Postgres de desenvolvimento: ../varal-infra/dev/compose.yml (container varal-dev-db, varal/varal, porta 5432).
# VARAL_DEV_DB_ADMIN_URL troca a URL usada para criar e apagar bancos; WORKTREE_BASE troca a base
# (padrão origin/main, útil só para testar o próprio script).
set -euo pipefail

readonly API_BASE_PORT=3000
readonly PANEL_BASE_PORT=3100
readonly ADMIN_BASE_PORT=3200
readonly MAX_OFFSET=99
readonly DB_USER_PASS='varal:varal'
readonly DB_HOST_PORT='localhost:5432'
readonly ADMIN_DB_URL="${VARAL_DEV_DB_ADMIN_URL:-postgresql://${DB_USER_PASS}@${DB_HOST_PORT}/postgres}"
readonly BASE_REF="${WORKTREE_BASE:-origin/main}"
readonly TYPES='feat|fix|docs|refactor|test|perf|style|build|ci|chore'

die() {
  echo "erro: $*" >&2
  exit 1
}

warn() {
  echo "aviso: $*" >&2
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  exit "${1:-0}"
}

# Raiz do checkout principal, mesmo quando o script roda dentro de um worktree.
main_root() {
  local common_dir
  common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
  dirname "$common_dir"
}

ROOT="$(main_root)"
readonly ROOT
readonly WORKTREES_DIR="$ROOT/.worktrees"

# Lê uma chave de um arquivo .env (sem executar o arquivo).
env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1 | tr -d '"'"'"
}

db_reachable() {
  command -v psql >/dev/null 2>&1 || return 1
  psql "$ADMIN_DB_URL" -Atqc 'SELECT 1' >/dev/null 2>&1
}

db_exists() {
  [[ "$(psql "$ADMIN_DB_URL" -Atqc "SELECT 1 FROM pg_database WHERE datname = '$1'")" == "1" ]]
}

# Nomes de banco vêm sempre de slugs validados ([a-z0-9_]); a checagem repete a garantia.
assert_worktree_db_name() {
  [[ "$1" =~ ^varal_[a-z0-9_]+$ && "$1" != "varal" ]] || die "nome de banco inesperado: '$1'"
}

create_db() {
  assert_worktree_db_name "$1"
  if db_exists "$1"; then
    echo "banco $1 já existe"
  else
    psql "$ADMIN_DB_URL" -qc "CREATE DATABASE \"$1\"" && echo "banco $1 criado"
  fi
}

drop_db() {
  assert_worktree_db_name "$1"
  if db_exists "$1"; then
    psql "$ADMIN_DB_URL" -qc "DROP DATABASE \"$1\" WITH (FORCE)" && echo "banco $1 apagado"
  fi
}

# PORT_OFFSETs já usados pelos outros worktrees.
used_offsets() {
  local env_file
  shopt -s nullglob
  for env_file in "$WORKTREES_DIR"/*/.env.local; do
    env_value "$env_file" PORT_OFFSET
  done
  shopt -u nullglob
}

free_offset() {
  local used offset
  used="$(used_offsets)"
  for ((offset = 1; offset <= MAX_OFFSET; offset++)); do
    if ! grep -qx "$offset" <<<"$used"; then
      echo "$offset"
      return 0
    fi
  done
  die "nenhum PORT_OFFSET livre entre 1 e $MAX_OFFSET; remova worktrees antigos"
}

slug_in_use() {
  local env_file
  shopt -s nullglob
  for env_file in "$WORKTREES_DIR"/*/.env.local; do
    if [[ "$(env_value "$env_file" WORKTREE_SLUG)" == "$1" ]]; then
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

cmd_new() {
  local branch="${1:-}"
  [[ -n "$branch" ]] || usage 1
  [[ "$branch" =~ ^($TYPES)/[a-z0-9][a-z0-9-]*$ ]] ||
    die "branch deve ser <tipo>/<descricao> em minúsculas com hífens; tipos: ${TYPES//|/, }"

  # RN-01.13: os hooks de bloqueio da main precisam estar ativos neste clone.
  local hooks_path
  hooks_path="$(git -C "$ROOT" config --get core.hooksPath || true)"
  if [[ "$hooks_path" != ".githooks" ]]; then
    die "core.hooksPath não aponta para .githooks (atual: '${hooks_path:-<vazio>}'). Ative com:
  git -C \"$ROOT\" config core.hooksPath .githooks"
  fi

  local type="${branch%%/*}" description="${branch#*/}"
  local name="${type}-${description}"
  local path="$WORKTREES_DIR/$name"
  # Slug: descrição em minúsculas, só [a-z0-9_]; limitado para o nome do banco caber em 63 caracteres.
  local slug
  slug="$(tr '[:upper:]-' '[:lower:]_' <<<"$description" | tr -cd 'a-z0-9_' | cut -c1-52)"
  [[ -n "$slug" ]] || die "não foi possível gerar o slug a partir de '$description'"

  [[ ! -e "$path" ]] || die "já existe $path"
  if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    die "a branch $branch já existe"
  fi
  if slug_in_use "$slug"; then
    die "o slug '$slug' já é usado por outro worktree (bancos varal_$slug); escolha outra descrição"
  fi

  local offset
  offset="$(free_offset)"
  local db="varal_${slug}" db_test="varal_${slug}_test"

  echo "==> criando worktree $path ($branch a partir de $BASE_REF)"
  git -C "$ROOT" fetch origin
  git -C "$ROOT" worktree add "$path" -b "$branch" "$BASE_REF"

  echo "==> gerando .env.local (PORT_OFFSET=$offset)"
  cat >"$path/.env.local" <<EOF
# Gerado por scripts/worktree.sh (spec 01, seção 4.1). Fora do git.
WORKTREE_SLUG=${slug}
PORT_OFFSET=${offset}
PORT=$((API_BASE_PORT + offset))
DATABASE_URL=postgresql://${DB_USER_PASS}@${DB_HOST_PORT}/${db}
DATABASE_URL_TEST=postgresql://${DB_USER_PASS}@${DB_HOST_PORT}/${db_test}
CORS_ORIGINS=http://localhost:${PANEL_BASE_PORT},http://localhost:${ADMIN_BASE_PORT},http://localhost:$((PANEL_BASE_PORT + offset)),http://localhost:$((ADMIN_BASE_PORT + offset))
EOF

  echo "==> instalando dependências"
  (cd "$path" && pnpm install --frozen-lockfile)

  if db_reachable; then
    echo "==> criando bancos e aplicando migrations"
    create_db "$db"
    create_db "$db_test"
    (cd "$path" && pnpm db:deploy)
    if grep -q '"db:seed"' "$path/package.json"; then
      (cd "$path" && pnpm db:seed)
    fi
  else
    warn "Postgres de desenvolvimento inacessível em ${ADMIN_DB_URL%%@*}@... (ou psql ausente)."
    warn "Suba com: docker compose -f ../varal-infra/dev/compose.yml up -d"
    warn "Depois crie os bancos $db e $db_test e rode 'pnpm db:deploy' em $path."
  fi

  echo
  echo "Pronto: $path"
  echo "  branch $branch | PORT_OFFSET $offset | API em http://localhost:$((API_BASE_PORT + offset)) | banco $db"
}

cmd_list() {
  printf '%-45s %-40s %6s %6s  %s\n' WORKTREE BRANCH OFFSET PORTA BANCO
  local line path="" branch=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path="${line#worktree }" ;;
      "branch "*) branch="${line#branch refs/heads/}" ;;
      "detached") branch="(detached)" ;;
      "")
        [[ -n "$path" ]] && print_worktree "$path" "$branch"
        path="" branch=""
        ;;
    esac
  done < <(git -C "$ROOT" worktree list --porcelain && echo)
}

print_worktree() {
  local path="$1" branch="$2" offset db url label
  if [[ "$path" == "$ROOT" ]]; then
    label="(principal)"
    offset="$(env_value "$path/.env.local" PORT_OFFSET)"
    offset="${offset:-0}"
  else
    label="${path#"$ROOT"/}"
    offset="$(env_value "$path/.env.local" PORT_OFFSET)"
  fi
  url="$(env_value "$path/.env.local" DATABASE_URL)"
  [[ -n "$url" ]] || url="$(env_value "$path/.env" DATABASE_URL)"
  db="${url##*/}"
  db="${db%%\?*}"
  if [[ -n "$offset" ]]; then
    printf '%-45s %-40s %6s %6s  %s\n' "$label" "$branch" "$offset" "$((API_BASE_PORT + offset))" "${db:--}"
  else
    printf '%-45s %-40s %6s %6s  %s\n' "$label" "$branch" "-" "-" "${db:--}"
  fi
}

cmd_remove() {
  local name="${1:-}"
  [[ -n "$name" ]] || usage 1
  name="${name#.worktrees/}"
  name="${name//\//-}"
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "nome inválido: '$name'"
  local path="$WORKTREES_DIR/$name"
  [[ -d "$path" ]] || die "worktree não encontrado: $path"
  git -C "$ROOT" worktree list --porcelain | grep -qx "worktree $path" ||
    die "$path não é um worktree registrado"

  if [[ -n "$(git -C "$path" status --porcelain)" ]]; then
    die "$path tem alterações sem commit; faça commit ou descarte antes de remover"
  fi

  # Só os bancos deste worktree, derivados do WORKTREE_SLUG dele.
  local slug
  slug="$(env_value "$path/.env.local" WORKTREE_SLUG)"
  if [[ -z "$slug" ]]; then
    warn "$path/.env.local sem WORKTREE_SLUG; nenhum banco será apagado"
  elif [[ ! "$slug" =~ ^[a-z0-9_]+$ ]]; then
    die "WORKTREE_SLUG inválido em $path/.env.local: '$slug'"
  elif db_reachable; then
    echo "==> apagando bancos do worktree"
    drop_db "varal_${slug}"
    drop_db "varal_${slug}_test"
  else
    warn "Postgres inacessível: os bancos varal_${slug} e varal_${slug}_test não foram apagados"
  fi

  echo "==> removendo worktree $path"
  cd "$ROOT"
  git -C "$ROOT" worktree remove "$path"
  echo "Removido. A branch foi mantida; apague-a depois do merge, se quiser."
}

case "${1:-}" in
  new) shift && cmd_new "$@" ;;
  list) cmd_list ;;
  remove) shift && cmd_remove "$@" ;;
  -h | --help | help) usage 0 ;;
  *) usage 1 ;;
esac
