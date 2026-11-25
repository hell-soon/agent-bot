#!/bin/bash
# Установка бота: проверяет зависимости, подключает GitHub App, создаёт bot.env и команду `bot`.
# Повторный запуск безопасен: можно поменять App, ключ или репозиторий по умолчанию.
set -e
BOT_DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
cd "$BOT_DIR"
say() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
ask() { local q=$1 def=$2 a; read -r -p "  $q${def:+ [$def]}: " a; printf '%s' "${a:-$def}"; }

say '1. Зависимости'
missing=0
for c in git gh jq node openssl curl; do
  if command -v "$c" >/dev/null; then ok "$c"; else bad "$c — поставьте: brew install $c"; missing=1; fi
done
# ИИ — хотя бы один: Claude Code или Codex
ais=0
if command -v claude >/dev/null; then ok "claude ($(claude --version 2>/dev/null | awk '{print $1}'))"; ais=1; else printf '  · claude не найден — https://claude.com/claude-code\n'; fi
if command -v codex >/dev/null; then ok 'codex'; ais=1; else printf '  · codex не найден — brew install codex\n'; fi
[ "$ais" = 1 ] || { bad 'нужен хотя бы один ИИ: Claude Code или Codex'; missing=1; }
[ "$missing" = 0 ] || { echo; echo 'Поставьте недостающее и запустите setup.sh ещё раз.'; exit 1; }

[ -f bot.env ] && . ./bot.env
echo
say '2. GitHub App бота'
echo '  Если приложения ещё нет — создайте по README (раздел «GitHub App»): права Contents, Pull requests, Issues — Read and write.'
APP_ID=$(ask 'App ID' "${GITHUB_APP_ID:-}")
[[ "$APP_ID" =~ ^[0-9]+$ ]] || { bad 'App ID — это число со страницы приложения'; exit 1; }
mkdir -p keys && chmod 700 keys
if [ ! -s keys/app.pem ] || [ "$(ask 'Заменить ключ приложения? (y/N)' n)" = y ]; then
  guess=$(ls -t "$HOME"/Downloads/*.private-key.pem 2>/dev/null | head -1)
  KEY=$(ask 'Путь к приватному ключу .pem' "$guess")
  KEY=${KEY/#\~/$HOME}
  [ -f "$KEY" ] || { bad "Нет файла $KEY"; exit 1; }
  cp "$KEY" keys/app.pem && chmod 600 keys/app.pem
  ok 'ключ скопирован в keys/app.pem'
fi

# сначала — только App ID и ключ (token.sh читает bot.env); прежний файл вернём, если что-то не так
umask 077
[ -f bot.env ] && cp bot.env bot.env.bak
restore() { [ -f bot.env.bak ] && mv bot.env.bak bot.env; }
printf 'GITHUB_APP_ID=%s\nGITHUB_APP_KEY=keys/app.pem\n' "$APP_ID" > bot.env
SLUG=$(./token.sh --app 2>/dev/null | jq -r '.slug // empty') || true
[ -n "$SLUG" ] || { restore; bad 'GitHub не принял App ID и ключ — проверьте, что ключ от этого приложения'; exit 1; }
ok "приложение: $SLUG"
BOT_ID=$(curl -sf "https://api.github.com/users/${SLUG}%5Bbot%5D" | jq -r '.id // empty')
[ -n "$BOT_ID" ] || { restore; bad 'Не нашёл пользователя бота на GitHub'; exit 1; }
ok "бот: ${SLUG}[bot]"

REPOS=$(./bin/gh api /installation/repositories --paginate --jq '.repositories[].full_name' 2>/dev/null || true)
[ -n "$REPOS" ] || { restore; bad 'Приложение не установлено ни на один репозиторий: страница приложения → Install App'; exit 1; }
echo '  Доступные репозитории:'; printf '%s\n' "$REPOS" | sed 's/^/    /'
DEF=$(ask 'Репозиторий по умолчанию' "${BOT_DEFAULT_REPO:-$(printf '%s\n' "$REPOS" | head -1)}")

cat > bot.env <<EOF
# Личные настройки бота — создаёт setup.sh. В git не попадает.
GITHUB_APP_ID=$APP_ID
GITHUB_APP_KEY=keys/app.pem
BOT_NAME='${SLUG}[bot]'
BOT_EMAIL='${BOT_ID}+${SLUG}[bot]@users.noreply.github.com'
BOT_DEFAULT_REPO=$DEF
EOF
chmod 600 bot.env; rm -f bot.env.bak
ok 'bot.env сохранён'

echo
say '3. Панель'
(cd ui && npm install --no-audit --no-fund --silent && npm run build --silent) && ok 'панель собрана (ui/dist)' || { bad 'не удалось собрать панель: cd ui && npm install && npm run build'; exit 1; }

echo
say '4. Команда bot'
mkdir -p "$HOME/.local/bin"
ln -sf "$BOT_DIR/agent.sh" "$HOME/.local/bin/bot"
chmod +x agent.sh token.sh bin/gh setup.sh
ok "~/.local/bin/bot → $BOT_DIR/agent.sh"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) printf '  · добавьте в ~/.zshrc: export PATH="$HOME/.local/bin:$PATH"\n' ;; esac

echo
say '5. Вход в ИИ'
if command -v claude >/dev/null; then
  if claude auth status >/dev/null 2>&1 || [ -s keys/claude-token ]; then ok 'Claude: вход есть'; else printf '  · Claude: выполните claude (вход) — или claude setup-token и вставьте токен в bot ui → Настройки\n'; fi
fi
if command -v codex >/dev/null; then
  if codex login status 2>&1 | grep -qi 'logged in'; then ok 'Codex: вход есть'; else printf '  · Codex: codex login\n'; fi
fi

echo
say 'Готово.'
echo '  bot ui        — панель в браузере'
echo '  bot help      — все команды'
echo '  Совет: защитите main в репозитории (README → «Безопасность»).'
