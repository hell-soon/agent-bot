#!/bin/bash
# Токен GitHub App бота (живёт 1 час) — печатает его в stdout.
#   token.sh          токен установки (для git push / gh)
#   token.sh --app    сведения о приложении (slug и т. п.) — для setup.sh
#   token.sh --repos  все репозитории всех установок (аккаунт + организации), JSON-массив
# Установок может быть несколько (ваш аккаунт, организации): токен — той, где стоит BOT_REPO=owner/repo
set -e
BOT_DIR=${BOT_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}
[ -f "$BOT_DIR/bot.env" ] && . "$BOT_DIR/bot.env"
APP_ID=${GITHUB_APP_ID:?нет GITHUB_APP_ID — запустите setup.sh}
PEM=${GITHUB_APP_KEY:-keys/app.pem}
case "$PEM" in /*) ;; *) PEM="$BOT_DIR/$PEM" ;; esac

b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
h=$(printf '{"alg":"RS256","typ":"JWT"}' | b64)
p=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now-60)) $((now+540)) "$APP_ID" | b64)
s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -sign "$PEM" | b64)
jwt="$h.$p.$s"
api() { curl -sf -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" "$@"; }

if [ "$1" = --app ]; then api https://api.github.com/app; exit; fi
if [ "$1" = --repos ]; then
  for i in $(api https://api.github.com/app/installations | jq -r '.[].id'); do
    t=$(api -X POST "https://api.github.com/app/installations/$i/access_tokens" | jq -r .token)
    curl -sf -H "Authorization: Bearer $t" -H "Accept: application/vnd.github+json" \
      "https://api.github.com/installation/repositories?per_page=100" | jq -r '.repositories[].full_name'
  done | jq -R . | jq -sc 'unique'
  exit
fi

# установка: из bot.env, иначе — та, где стоит BOT_REPO (запоминаем по владельцу), иначе — первая
inst=${GITHUB_APP_INSTALLATION:-}
if [ -z "$inst" ] && [[ "${BOT_REPO:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  cache="$BOT_DIR/logs/.installation-${BOT_REPO%%/*}"
  inst=$(cat "$cache" 2>/dev/null || true)
  if [ -z "$inst" ]; then
    inst=$(api "https://api.github.com/repos/$BOT_REPO/installation" | jq -r '.id // empty' || true)
    [ -n "$inst" ] && { mkdir -p "$BOT_DIR/logs"; echo "$inst" > "$cache"; }
  fi
fi
inst=${inst:-$(api https://api.github.com/app/installations | jq -r '.[0].id // empty')}
[ -n "$inst" ] || { echo "Приложение никуда не установлено: GitHub → Settings → Applications → Configure" >&2; exit 1; }
api -X POST "https://api.github.com/app/installations/$inst/access_tokens" | jq -r .token
