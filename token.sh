#!/bin/bash
# Токен GitHub App бота (живёт 1 час) — печатает его в stdout.
#   token.sh          токен установки (для git push / gh)
#   token.sh --app    сведения о приложении (slug и т. п.) — для setup.sh
#   token.sh --repos  репозитории разрешённых установок (аккаунт + организации), JSON-массив
#   token.sh --installations       все установки приложения с пометкой allowed, JSON
#   token.sh --uninstall ID        удалить чужую установку (разрешённую — нельзя)
# BOT_OWNERS в bot.env — через запятую, чьи установки боту можно использовать (пусто — любые).
# Приложение публичное: поставить его себе может кто угодно — без списка его репы попали бы в вашу панель.
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
owners=$(printf '%s' "${BOT_OWNERS:-}" | tr 'A-Z' 'a-z' | tr -d ' ')
allowed() { [ -z "$owners" ] && return 0; case ",$owners," in *",$(printf '%s' "$1" | tr 'A-Z' 'a-z'),"*) return 0 ;; esac; return 1; }
insts() { api "https://api.github.com/app/installations?per_page=100"; }
allowed_ids() { insts | jq -r '.[] | "\(.id) \(.account.login)"' | while read -r i o; do allowed "$o" && echo "$i"; done; }

if [ "$1" = --installations ]; then
  insts | jq -c --arg o "$owners" '[.[] | (.account.login | ascii_downcase) as $l | {id, owner: .account.login, type: .account.type,
    selection: .repository_selection, allowed: ($o == "" or (("," + $o + ",") | contains("," + $l + ",")))}]'
  exit
fi
if [ "$1" = --uninstall ]; then
  id=$2; [[ "$id" =~ ^[0-9]+$ ]] || { echo "Нужен id установки" >&2; exit 1; }
  o=$(insts | jq -r --argjson id "$id" '.[] | select(.id == $id) | .account.login')
  [ -n "$o" ] || { echo "Нет такой установки" >&2; exit 1; }
  allowed "$o" && { echo "$o в списке разрешённых — сначала уберите его оттуда" >&2; exit 1; }
  api -X DELETE "https://api.github.com/app/installations/$id" >/dev/null && echo "удалено: $o"
  exit
fi
if [ "$1" = --repos ]; then
  for i in $(allowed_ids); do
    t=$(api -X POST "https://api.github.com/app/installations/$i/access_tokens" | jq -r .token)
    curl -sf -H "Authorization: Bearer $t" -H "Accept: application/vnd.github+json" \
      "https://api.github.com/installation/repositories?per_page=100" | jq -r '.repositories[].full_name'
  done | jq -R . | jq -sc 'unique'
  exit
fi

# установка: из bot.env, иначе — та, где стоит BOT_REPO (запоминаем по владельцу), иначе — первая
inst=${GITHUB_APP_INSTALLATION:-}
if [[ "${BOT_REPO:-}" =~ ^[A-Za-z0-9_.-]+/ ]] && ! allowed "${BOT_REPO%%/*}"; then
  echo "${BOT_REPO%%/*} нет в BOT_OWNERS (bot.env) — боту туда нельзя" >&2; exit 1
fi
if [ -z "$inst" ] && [[ "${BOT_REPO:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  cache="$BOT_DIR/logs/.installation-${BOT_REPO%%/*}"
  inst=$(cat "$cache" 2>/dev/null || true)
  if [ -z "$inst" ]; then
    inst=$(api "https://api.github.com/repos/$BOT_REPO/installation" | jq -r '.id // empty' || true)
    [ -n "$inst" ] && { mkdir -p "$BOT_DIR/logs"; echo "$inst" > "$cache"; }
  fi
fi
inst=${inst:-$(allowed_ids | head -1)}
[ -n "$inst" ] || { echo "Приложение никуда не установлено: GitHub → Settings → Applications → Configure" >&2; exit 1; }
api -X POST "https://api.github.com/app/installations/$inst/access_tokens" | jq -r .token
