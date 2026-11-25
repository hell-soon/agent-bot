#!/bin/bash
# Токен GitHub App бота (живёт 1 час) — печатает его в stdout.
#   token.sh          токен установки (для git push / gh)
#   token.sh --app    сведения о приложении (slug и т. п.) — для setup.sh
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
# установка приложения: задана в bot.env или первая найденная
inst=${GITHUB_APP_INSTALLATION:-$(api https://api.github.com/app/installations | jq -r '.[0].id // empty')}
[ -n "$inst" ] || { echo "Приложение никуда не установлено: GitHub → Settings → Applications → Configure" >&2; exit 1; }
api -X POST "https://api.github.com/app/installations/$inst/access_tokens" | jq -r .token
