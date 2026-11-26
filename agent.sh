#!/bin/bash
# bot — ИИ-агент (Claude / Codex) от имени вашего GitHub App-бота в ваших репозиториях.
# Команды: bot help · установка: ./setup.sh
set -e
BOT_DIR=${BOT_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}
export BOT_DIR
LOGS="$BOT_DIR/logs"
# Личные настройки (App ID, имя бота, репозиторий по умолчанию) — bot.env, его создаёт setup.sh
if [ -f "$BOT_DIR/bot.env" ]; then set -a; . "$BOT_DIR/bot.env"; set +a
else case "$1" in help|-h|--help) ;; *) echo "Бот ещё не настроен: запустите $BOT_DIR/setup.sh" >&2; exit 1 ;; esac; fi
DEFAULT_REPO=${BOT_DEFAULT_REPO:-}
# Общие флаги перед командой: -r owner/repo (в каком репозитории), --ref owner/x[,owner/y] (подсмотреть, только чтение)
while :; do
  case "$1" in
    -r|--repo) BOT_REPO=$2; shift 2 ;;
    --ref)     BOT_REFS=${BOT_REFS:+$BOT_REFS,}$2; shift 2 ;;
    *) break ;;
  esac
done
BOT_NAME=${BOT_NAME:-bot}
BOT_EMAIL=${BOT_EMAIL:-bot@users.noreply.github.com}
UI_PORT=4545

usage() { cat <<'EOF'
bot ui                  панель в браузере: запуск задач кнопками, живая лента, очередь (bot ui stop — выключить)
bot                     обычная сессия от имени бота
bot 5                   сделать issue #5 (вы смотрите и разрешаете действия)
bot q 5 6 7             очередь: issue по очереди, сам и без вопросов, каждое — свой PR от базовой ветки
bot chain 5 6 7         то же, но каждое следующее — поверх предыдущего (тикеты зависят друг от друга)
bot q ready             очередь из всех открытых issue с меткой ready-for-agent
bot pr 7                поправить PR #7 по комментариям ревью и упавшим проверкам
bot pr 7 "текст"        поправить PR #7 как сказано
bot idea "текст"        обсудить большую фичу (/grill-with-docs), потом /to-spec, /to-tickets
bot bug "текст"         разобрать баг (/diagnosing-bugs)
bot triage              разобрать новые issue (/triage)
bot log [N]             лог последней очереди (или issue #N)
bot "любой текст"       любая задача

Другой репозиторий:  bot -r owner/site 5    (или запуск из папки этого репозитория)
Подсмотреть в другом: bot --ref owner/site 5   (только чтение; можно несколько через запятую)

Модель/усилия: BOT_MODEL=opus BOT_EFFORT=high bot …   (тикеты по умолчанию — sonnet, medium)
Другой ИИ:     BOT_AI=codex bot 5   (по умолчанию — из настроек панели; модель Codex — BOT_CODEX_MODEL)
EOF
}
case "$1" in help|-h|--help) usage; exit 0 ;; esac

if [ "$1" = log ]; then
  if [ -n "$2" ]; then f="$LOGS/issue-$2.log"; else f=$(ls -t "$LOGS"/*.log 2>/dev/null | head -1); fi
  [ -f "$f" ] || { echo "логов нет"; exit 1; }
  exec less +G "$f"
fi

if [ "$1" = ui ]; then
  mkdir -p "$LOGS"
  pid=$(lsof -ti tcp:$UI_PORT -sTCP:LISTEN 2>/dev/null || true)
  if [ "$2" = stop ]; then [ -n "$pid" ] && kill $pid && echo "Панель выключена" || echo "Панель не запущена"; exit 0; fi
  if [ ! -f "$BOT_DIR/ui/dist/index.html" ]; then
    echo "Собираю панель (один раз)…"
    (cd "$BOT_DIR/ui" && npm install --no-audit --no-fund --silent && npm run build --silent) || { echo "Не удалось собрать панель: cd $BOT_DIR/ui && npm install && npm run build" >&2; exit 1; }
  fi
  if [ -z "$pid" ]; then
    nohup node "$BOT_DIR/ui/server.mjs" >> "$LOGS/ui.log" 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 0.3; lsof -ti tcp:$UI_PORT -sTCP:LISTEN >/dev/null 2>&1 && break; done
  fi
  echo "Панель: http://127.0.0.1:$UI_PORT"; open "http://127.0.0.1:$UI_PORT"; exit 0
fi

export PATH="$BOT_DIR/bin:$PATH"   # gh с токеном бота, свежим на каждый вызов

here_repo() { # репозиторий GitHub папки, из которой запустили bot (кроме копий самого бота)
  case "$PWD" in "$BOT_DIR"*) return 0 ;; esac
  git remote get-url origin 2>/dev/null | sed -nE 's#^(https://github\.com/|git@github\.com:)([^/]+/[^/]+?)(\.git)?$#\2#p'
}

# Настройки из панели (bot ui → ⚙) — config.json рядом со скриптом; переменные BOT_* важнее
CONFIG="$BOT_DIR/config.json"
cfg() { jq -r "$1 // empty" "$CONFIG" 2>/dev/null || true; }
# Долгоживущий токен подписки (claude setup-token): бот не зависит от вашего обычного входа
TOKEN_FILE="$BOT_DIR/keys/claude-token"
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -s "$TOKEN_FILE" ]; then
  CLAUDE_CODE_OAUTH_TOKEN=$(tr -d ' \n\r' < "$TOKEN_FILE"); export CLAUDE_CODE_OAUTH_TOKEN
fi
HEADLESS=""; case "$1" in _*) HEADLESS=1 ;; esac

setup_repo() {
  if [ ! -d "$WORK/.git" ]; then
    mkdir -p "$(dirname "$WORK")"
    local T; T="$("$BOT_DIR/token.sh")"
    git clone -q "https://x-access-token:$T@github.com/$REPO.git" "$WORK"
    git -C "$WORK" remote set-url origin "https://github.com/$REPO.git"
  fi
  cd "$WORK"
  git config --local user.name  "$BOT_NAME"
  git config --local user.email "$BOT_EMAIL"
  git config --local commit.gpgsign false
  git config --local --unset-all credential.helper 2>/dev/null || true
  git config --local --add credential.helper ''
  git config --local --add credential.helper \
    "!f() { echo username=x-access-token; echo password=\$(BOT_REPO=$REPO $BOT_DIR/token.sh); }; f"
  # Пуш в базовую ветку — только через PR: git-хук в копии бота, работает и для Claude, и для Codex
  # (защита от ошибки, а не от умысла; на GitHub — ещё Rulesets)
  git config --local --unset core.hooksPath 2>/dev/null || true
  local hook; hook="$(git rev-parse --git-path hooks)/pre-push"; mkdir -p "$(dirname "$hook")"
  cat > "$hook" <<HOOK
#!/bin/sh
# Поставлен ботом: пуш в $BASE (и main/master) запрещён — только ветка + PR
while read -r lref lsha rref rsha; do
  case "\$rref" in refs/heads/$BASE|refs/heads/main|refs/heads/master)
    echo "bot: пуш в \$rref запрещён — работай в своей ветке и открой PR" >&2; exit 1 ;;
  esac
done
exit 0
HOOK
  chmod +x "$hook"
}

fresh_main() { # чистый main с GitHub; несохранённое от прошлого раза — спросить (или отказаться в фоне)
  if [ -n "$(git status --porcelain)" ]; then
    if [ -n "$HEADLESS" ]; then
      printf '{"type":"bot_error","code":"dirty","text":"В копии бота остались незакоммиченные изменения от прошлого запуска"}\n'; exit 3
    fi
    echo "В $WORK остались незакоммиченные изменения от прошлого запуска:"; git status --short
    read -r -p "Отбросить их? [y/N] " a; [ "$a" = y ] || exit 1
    git reset -q --hard && git clean -qfd
  fi
  git fetch -q origin && git checkout -q "$BASE" && git reset -q --hard "origin/$BASE"
}

REPO=${BOT_REPO:-}
[ -z "$REPO" ] && case "$1" in _*) ;; *) REPO=$(here_repo) ;; esac
REPO=${REPO:-$(cfg .repo)}; REPO=${REPO:-$DEFAULT_REPO}
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Неверный репозиторий: $REPO (нужно owner/name)" >&2; exit 1; }
[ -n "$REPO" ] || { echo "Не знаю, в каком репозитории работать: bot -r owner/repo … или BOT_DEFAULT_REPO в bot.env" >&2; exit 1; }
export BOT_REPO="$REPO" # token.sh берёт установку приложения того владельца (аккаунт или организация)
WORK="$BOT_DIR/work/${REPO//\//__}"
# прежняя раскладка (work/<имя>) — переносим один раз
[ ! -d "$WORK" ] && [ -d "$BOT_DIR/work/${REPO#*/}/.git" ] && mv "$BOT_DIR/work/${REPO#*/}" "$WORK"

# Настройки этого репозитория из панели: config.json → repos["owner/repo"]
rcfg() { jq -r --arg r "$REPO" ".repos[\$r]$1 // empty" "$CONFIG" 2>/dev/null || true; }
# Базовая ветка: из настроек репозитория, иначе ветка по умолчанию на GitHub
BASE=${BOT_BASE:-$(rcfg .base)}
if [ -z "$BASE" ] && [ -d "$WORK/.git" ]; then BASE=$(git -C "$WORK" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'); fi
[ -z "$BASE" ] && BASE=$(gh api "repos/$REPO" --jq .default_branch 2>/dev/null || true)
BASE=${BASE:-main}

PROMPT="Ты работаешь как бот $BOT_NAME в репозитории $REPO, базовая ветка — $BASE.
Обязательные правила:
- Никогда не коммить и не пушь в $BASE. Если ветка уже создана за тебя — работай в ней, иначе создай agent/<кратко>.
- PR открывай через gh pr create --base $BASE. Без Co-Authored-By и «Generated with Claude Code» в коммитах и PR — автор и так бот.
- Команды запускай по одной: без ;, &&, ||, \$? и подстановок \$(...) — в фоновом режиме составные команды запрещены и только тратят шаги. Длинный вывод — через | tail -n 30.
- Экономь контекст и шаги: ищи Grep-ом и читай нужные куски (Read с offset/limit), не файлы целиком; не перечитывай прочитанное; подагентов (Task) — только для широкого поиска.
- Не трогай .env* и секреты. Не делай merge и force push — PR смотрит владелец."

# Правила владельца (панель → Настройки → Правила): общие и для этого репозитория
RULES_DIR="$BOT_DIR/rules"; mkdir -p "$RULES_DIR"
if [ ! -f "$RULES_DIR/_global.md" ]; then cat > "$RULES_DIR/_global.md" <<'RULES'
- Правила проекта — в AGENTS.md / CLAUDE.md; если есть docs/features/<раздел>.md — сначала прочитай нужный. Если есть docs/agents/*.md — там настройки скиллов (трекер, метки, доменные документы).
- Проверки — те, что описаны в AGENTS.md / CLAUDE.md (иначе скрипты package.json: typecheck, lint, test, build), один раз в конце, по одной команде, вывод через | tail -n 40. Упало — чини и перезапусти только упавшую. Нет зависимостей — поставь (npm ci / pnpm i --frozen-lockfile / bun install).
- Описание PR — по-русски: что сделано, как проверено. В конце — Closes #N, если задача из issue.
- Создаёшь или разбираешь issue (/to-tickets, /triage) — ставь метку размера: size:s (минуты, 1–2 файла), size:m (обычная задача), size:l (много файлов, новая логика).
RULES
fi
RULES_REPO="$RULES_DIR/${REPO//\//__}.md"
PROMPT="$PROMPT

## Правила владельца
$(cat "$RULES_DIR/_global.md")"
[ -s "$RULES_REPO" ] && PROMPT="$PROMPT

## Правила для $REPO
$(cat "$RULES_REPO")"
# Настройки репозитория, которые меняют работу с PR и проверками
X=$(rcfg .checks); [ -n "$X" ] && PROMPT="$PROMPT
- Проверки в этом репозитории (вместо любых других): $X"
[ "$(rcfg .draft)" = true ] && PROMPT="$PROMPT
- PR открывай черновиком: gh pr create --draft"
X=$(rcfg .reviewers); [ -n "$X" ] && PROMPT="$PROMPT
- Добавь ревьюеров PR: --reviewer $X"
X=$(rcfg .labels); [ -n "$X" ] && PROMPT="$PROMPT
- Поставь PR метки: --label $X"
X=$(jq -r '[.denyCmds[]?] | join(", ")' "$CONFIG" 2>/dev/null); [ -n "$X" ] && PROMPT="$PROMPT
- Никогда не запускай: $X"

export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1   # одна память — наш файл, без встроенной автопамяти
# Память бота по репозиторию: что он узнал в прошлых задачах. Вне репозитория — не попадает в PR.
MEMORY_DIR="$BOT_DIR/memory"; MEMORY_FILE="$MEMORY_DIR/${REPO//\//__}.md"
mkdir -p "$MEMORY_DIR"; [ -f "$MEMORY_FILE" ] || printf '# Память бота: %s\n\n' "$REPO" > "$MEMORY_FILE"
PROMPT="$PROMPT

## Память по этому репозиторию
Ниже — то, что ты сам узнал в прошлых задачах (файл $MEMORY_FILE). Доверяй, но если код говорит другое — прав код, а пункт исправь.
<memory>
$(head -c 6000 "$MEMORY_FILE")
</memory>
Встроенной автопамяти Claude Code (MEMORY.md в ~/.claude) у тебя нет — память только в этом файле. В конце задачи, если узнал что-то полезное на будущее и неочевидное из кода и docs/ (где что лежит, как быстро проверить, на чём споткнулся, предпочтения владельца из ревью), — допиши в этот файл 1–3 коротких пункта под заголовком раздела. Без дублей, без пересказа задачи, без того, что уже есть в AGENTS.md. Файл больше 4 КБ — сожми: объедини похожее, убери устаревшее."

# Только нужное: настройки проекта (без ваших личных плагинов, SEO/Figma-скиллов, MCP, хуков),
# скиллы Мэтта Покока — отдельно; одинаковый системный промпт у всех запусков → старт берётся из кэша.
# Скиллы — собранный плагин .skills (панель → Настройки → Скиллы: вкл/выкл, установка из GitHub)
[ -d "$BOT_DIR/.skills/skills" ] || node "$BOT_DIR/ui/skills.mjs" build >/dev/null 2>&1 || true
SKILLS_DIR="$BOT_DIR/.skills"
SETTINGS='{"attribution":{"commit":"","pr":""},"includeCoAuthoredBy":false,"env":{"ENABLE_TOOL_SEARCH":"auto:5","CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"85","CLAUDE_CODE_DISABLE_AUTO_MEMORY":"1","CLAUDE_CODE_SUBAGENT_MODEL":"haiku","BASH_MAX_OUTPUT_LENGTH":"15000"},"autoMemoryEnabled":false}'
OPTS=(--append-system-prompt "$PROMPT" --settings "$SETTINGS"
  --strict-mcp-config --setting-sources project,local --exclude-dynamic-system-prompt-sections)
[ -d "$SKILLS_DIR/skills" ] && OPTS+=(--plugin-dir "$SKILLS_DIR" --add-dir "$SKILLS_DIR")
OPTS+=(--add-dir "$MEMORY_DIR")   # чтобы бот мог дописывать память без вопросов

# Вложения из панели (BOT_FILES — пути, по одному в строке): дописываются к задаче/ответу один раз
ATTACH_NOTE=""; CODEX_IMAGES=""
if [ -n "$BOT_FILES" ]; then
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    ATTACH_NOTE="$ATTACH_NOTE
- $f"
    printf '%s' "$f" | grep -qiE '\.(png|jpe?g|gif|webp)$' && CODEX_IMAGES="${CODEX_IMAGES:+$CODEX_IMAGES
}$f"
  done <<< "$BOT_FILES"
fi
[ -d "$BOT_DIR/uploads" ] && OPTS+=(--add-dir "$BOT_DIR/uploads")
# Исходящие файлы (BOT_OUTBOX от панели): что бот кладёт сюда, панель показывает в ленте и шлёт в Telegram
OUTBOX_NOTE=""
if [ -n "$BOT_OUTBOX" ]; then
  mkdir -p "$BOT_OUTBOX"
  OUTBOX_NOTE="

## Файлы для владельца
Если нужно показать владельцу картинку или файл — скриншот, сгенерированное изображение, макет, отчёт, — положи копию в $BOT_OUTBOX: панель покажет их в ленте. Картинки, созданные генерацией изображений, тоже копируй туда (только выбранные). Секретов туда не клади. Файлы, которые нужны проекту, — как обычно в репозиторий."
fi

# Справочные репозитории (--ref / BOT_REFS): свежая копия только для чтения в refs/
REF_NOTE=""
if [ -n "$BOT_REFS" ]; then
  IFS=',' read -ra _refs <<< "$BOT_REFS"
  for r in "${_refs[@]}"; do
    r=${r// /}; [[ "$r" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || continue; [ "$r" = "$REPO" ] && continue
    d="$BOT_DIR/refs/${r//\//__}"
    if [ -d "$d/.git" ]; then git -C "$d" fetch -q --depth 1 origin HEAD 2>/dev/null && git -C "$d" reset -q --hard FETCH_HEAD
    else mkdir -p "$BOT_DIR/refs"; git clone -q --depth 1 "https://x-access-token:$(BOT_REPO=$r "$BOT_DIR/token.sh")@github.com/$r.git" "$d" || { echo "Нет доступа к $r — пропускаю" >&2; continue; }
      git -C "$d" remote set-url origin "https://github.com/$r.git"; fi
    OPTS+=(--disallowedTools "Edit(/$d/**)" "Write(/$d/**)" "Bash(git -C $d:*)" --add-dir "$d")
    REF_NOTE="$REF_NOTE
- $r — $d"
  done
  [ -n "$REF_NOTE" ] && PROMPT="$PROMPT

## Другие репозитории для справки (только чтение — ничего в них не меняй, не коммить)
Смотри туда, когда задача просит «как там» или нужен пример: ищи Grep-ом, читай кусками.$REF_NOTE"
  OPTS[1]="$PROMPT"   # обновить --append-system-prompt
fi
[ -n "$OUTBOX_NOTE" ] && { PROMPT="$PROMPT$OUTBOX_NOTE"; OPTS[1]="$PROMPT"; }

# «Фича» (BOT_MODE=idea или bot idea): только обсуждение → спецификация → issue, код не трогать
[ "$1" = idea ] && BOT_MODE=idea
if [ "$BOT_MODE" = idea ]; then
  PROMPT="$PROMPT

## Режим «Фича»: обсуждение, а не разработка
Это обсуждение новой функции. Код НЕ пиши и файлы проекта НЕ меняй (можно только docs/: ADR и глоссарий, если этого просит скилл), ветки, коммиты и PR НЕ создавай — даже если всё ясно и человек ответил на все вопросы.
1. Задавай вопросы по одному, пока не станет понятно, что и зачем делаем.
2. Когда договорились — покажи короткую спецификацию (что делаем, что не делаем, критерии готовности) и спроси, всё ли верно.
3. После «да» — заведи issue: gh issue create -R $REPO с этой спецификацией и меткой ready-for-agent (и size:s|m|l по объёму). Большую фичу — разбей на несколько issue (по одному на самостоятельный кусок, с порядком «после #N»).
4. В конце дай ссылки на issue. Делать их будет отдельная задача — не ты сейчас."
  OPTS[1]="$PROMPT"
fi
# Какой ИИ работает: claude (по умолчанию) или codex. BOT_AI=codex bot … — разово; в панели — ⚙ или у задачи.
AI=${BOT_AI:-$(rcfg .ai)}; AI=${AI:-$(cfg .ai)}
case "${AI:-claude}" in claude|codex) ;; *) echo "Неизвестный ИИ: $AI (claude | codex)" >&2; exit 1 ;; esac
# Нужен хотя бы один ИИ. Выбранный в настройках не установлен — работает тот, что есть; явный BOT_AI — без подмены
if ! command -v "${AI:-claude}" >/dev/null; then
  other=claude; [ "${AI:-claude}" = claude ] && other=codex
  if [ -n "$BOT_AI" ]; then echo "$BOT_AI не установлен (BOT_AI=$BOT_AI)" >&2; exit 1
  elif command -v "$other" >/dev/null; then AI=$other
  else echo "Нет ни одного ИИ: поставьте Claude Code (claude.com/claude-code) или Codex (brew install codex)" >&2; exit 1; fi
fi
AI=${AI:-claude}
ADAPTER="$BOT_DIR/ui/codex-adapter.mjs"

model_opts() { # cheap — значения по умолчанию для тикетов
  local m="$BOT_MODEL" e="$BOT_EFFORT"
  if [ "$AI" = codex ]; then   # у Codex свои модели и усилия (настройки codex*), размер задачи меняет только усилия
    if [ "$1" = cheap ]; then CODEX_MODEL=${BOT_CODEX_MODEL:-$(rcfg .codexModel)}; CODEX_MODEL=${CODEX_MODEL:-$(cfg .codexModel)}; e=${e:-$(cfg .codexEffort)}
    else CODEX_MODEL=${BOT_CODEX_MODEL:-$(cfg .codexChatModel)}; CODEX_MODEL=${CODEX_MODEL:-$(cfg .codexModel)}; e=${e:-$(cfg .codexChatEffort)}; fi
    export CODEX_MODEL; [ -n "$e" ] && export CODEX_EFFORT="$e"
    return 0
  fi
  if [ "$1" = cheap ]; then m=${m:-$(rcfg .ticketModel)}; m=${m:-$(cfg .ticketModel)}; m=${m:-sonnet}; e=${e:-$(cfg .ticketEffort)}; e=${e:-medium}
  else m=${m:-$(cfg .chatModel)}; e=${e:-$(cfg .chatEffort)}; fi
  if [ "$AI" = codex ]; then   # имена моделей Claude Codex не подходят — своя модель из настроек
    CODEX_MODEL=${BOT_CODEX_MODEL:-$(cfg .codexModel)}; export CODEX_MODEL
    [ -n "$e" ] && export CODEX_EFFORT="$e"
    return 0
  fi
  if [ -n "$m" ]; then OPTS+=(--model "$m"); fi
  if [ -n "$e" ]; then OPTS+=(--effort "$e"); fi
}

# Модель по размеру задачи (метки size:s|m|l): s — Haiku, m — Sonnet, l — Opus с высокими усилиями.
# Действует, только если модель не выбрана явно (BOT_MODEL / выбор в панели); выключить — ⚙ «Модель по размеру».
SIZE=""
size_model() { # $1 — номер issue
  SIZE=$(gh issue view "$1" -R "$REPO" --json labels --jq '[.labels[].name | select(startswith("size:"))][0] // "" | ltrimstr("size:")' 2>/dev/null || true)
  [ "$(jq -r .sizeModels "$CONFIG" 2>/dev/null)" = false ] && return 0
  case "$SIZE" in
    s) : "${BOT_MODEL:=haiku}" "${BOT_EFFORT:=low}" ;;
    m) : "${BOT_MODEL:=sonnet}" "${BOT_EFFORT:=medium}" ;;
    l) : "${BOT_MODEL:=opus}" "${BOT_EFFORT:=high}" ;;
  esac
  [ -n "$SIZE" ] && printf '{"type":"bot_note","text":"Размер size:%s → %s"}\n' "$SIZE" "$( [ "$AI" = codex ] && echo "Codex, усилия ${BOT_EFFORT:-?}" || echo "${BOT_MODEL:-?}, усилия ${BOT_EFFORT:-?}")"
  return 0
}

# Скиллы для Codex: «/имя …» → «выполни инструкцию из файла SKILL.md» (команд-скиллов у Codex нет)
to_codex() {
  local t="$1" s rest p
  if [[ "$t" =~ ^/([a-z0-9-]+)(.*)$ ]]; then
    s=${BASH_REMATCH[1]}; rest=${BASH_REMATCH[2]}
    p="$SKILLS_DIR/skills/$s/SKILL.md"; [ -f "$p" ] || p=$(find "$WORK/.claude/skills" -path "*/$s/SKILL.md" 2>/dev/null | head -1)
    [ -n "$p" ] && t="Прочитай и выполни инструкцию скилла из файла $p (упомянутые там инструменты Claude Code заменяй своими аналогами: вопросы человеку — текстом).$rest"
  fi
  printf '%s' "$t"
}

# Фоновый запуск в формате событий Claude (stream-json):
#   ai_run new <panel 0|1> "задача"    |    ai_run resume <panel 0|1> SESSION "сообщение"
ai_run() {
  local mode=$1 panel=$2; shift 2
  if [ -n "$ATTACH_NOTE" ]; then
    local note="

## Вложения от владельца
Владелец приложил файлы — это часть задачи. Открой и посмотри их (картинки — через Read):$ATTACH_NOTE"
    if [ "$mode" = new ]; then set -- "$1$note"; else set -- "$1" "$2$note"; fi
    ATTACH_NOTE=""
    [ "$AI" = codex ] && export CODEX_IMAGES
  fi
  if [ "$AI" = codex ]; then
    export CODEX_WRITABLE="$MEMORY_DIR${BOT_OUTBOX:+:$BOT_OUTBOX}"
    if [ "$mode" = new ]; then
      local pre="$PROMPT"; [ "$panel" = 1 ] && pre="$pre

$PANEL_PROMPT"
      node "$ADAPTER" new "$pre

## Задача
$(to_codex "$1")"
    else node "$ADAPTER" resume "$1" "$(to_codex "$2")"; fi
    unset CODEX_IMAGES
  else
    local extra=(); [ "$panel" = 1 ] && extra=(--append-system-prompt "$PANEL_PROMPT")
    if [ "$mode" = new ]; then claude "${AUTO[@]}" "${STREAM[@]}" "${OPTS[@]}" "${extra[@]}" -- "$1"
    else claude "${AUTO[@]}" "${STREAM[@]}" "${OPTS[@]}" "${extra[@]}" --resume "$1" -- "$2"; fi
  fi
}
# Интерактивно в терминале
ai_tty() {
  if [ "$AI" = codex ]; then
    exec codex -c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.network_access=true' \
      -c "sandbox_workspace_write.writable_roots=[\"$MEMORY_DIR\"]" ${CODEX_MODEL:+-m "$CODEX_MODEL"} \
      "$PROMPT

## Задача
$(to_codex "${1:-Жди задачу от владельца.}")"
  fi
  if [ -n "$1" ]; then exec claude "${OPTS[@]}" -- "$1"; else exec claude "${OPTS[@]}"; fi
}

# Без вопросов: только git/gh/npm/node и правка файлов в копии репозитория
AUTO=(-p --permission-mode acceptEdits
  --allowedTools "Read" "Grep" "Glob" "Edit" "Write" "TodoWrite" "Skill" "Task"
    "Bash(git:*)" "Bash(gh:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)"
    "Bash(ls:*)" "Bash(cat:*)" "Bash(grep:*)" "Bash(rg:*)" "Bash(find:*)" "Bash(sed -n:*)"
    "Bash(head:*)" "Bash(tail:*)" "Bash(wc:*)" "Bash(mkdir:*)" "Bash(curl -s http://127.0.0.1:*)"
    "Bash(jq:*)" "Bash(sort:*)" "Bash(uniq:*)" "Bash(diff:*)" "Bash(test:*)" "Bash(pwd)" "Bash(echo:*)"
  --disallowedTools "Bash(git push --force:*)" "Bash(git push -f:*)" "Bash(git push origin $BASE:*)" "Bash(git push --force-with-lease:*)"
  "Bash(git push --no-verify:*)" "Bash(git -c:*)" "Bash(git config:*)"
    "Bash(gh pr merge:*)" "Bash(gh repo delete:*)" "Bash(gh api -X DELETE:*)" "AskUserQuestion")
# Свои разрешения (панель → Настройки → Разрешения): allowCmds / denyCmds — начала команд
while IFS= read -r c; do [ -n "$c" ] && AUTO+=(--allowedTools "Bash($c:*)"); done < <(jq -r '.allowCmds[]? // empty' "$CONFIG" 2>/dev/null)
while IFS= read -r c; do [ -n "$c" ] && AUTO+=(--disallowedTools "Bash($c:*)"); done < <(jq -r '.denyCmds[]? // empty' "$CONFIG" 2>/dev/null)
# «Фича» — без коммитов, пуша и PR (Codex — по правилу в промпте)
[ "$BOT_MODE" = idea ] && AUTO+=(--disallowedTools "Bash(git commit:*)" "Bash(git push:*)" "Bash(gh pr create:*)")
STREAM=(--output-format stream-json --verbose)
# Предохранитель: фоновая задача не потратит больше $BOT_BUDGET (по умолчанию $8) — дальше остановится, работу можно «Продолжить»
B=${BOT_BUDGET:-$(cfg .budget)}; AUTO+=(--max-budget-usd "${B:-8}")

# Code Mode (экспериментальный): Claude пишет JS, который делает несколько вызовов за шаг. Только в интерактивных сессиях
# (с -p не работает) и только с Claude Code ≥ 2.1.323. Выключить: BOT_CODE_MODE=0 bot …
code_mode() {
  [ "${BOT_CODE_MODE:-1}" = 0 ] && return 0
  [ "$(jq -r .codeMode "$CONFIG" 2>/dev/null)" = false ] && return 0
  local v; v=$(claude --version 2>/dev/null | awk '{print $1}')
  [ "$(printf '%s\n2.1.323\n' "$v" | sort -V | head -1)" = 2.1.323 ] && export CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1
  return 0
}

issue_task() { # $1 — номер, $2 — ветка, $3 — база
  local review="Перед PR — самопроверка: git diff $3...HEAD глазами строгого ревьюера (ошибки, крайние случаи, правила AGENTS.md и docs/features, лишние изменения) — найденное исправь."
  [ "$SIZE" = l ] && review="Перед PR — /code-review изменений относительно $3 и исправь найденное."
  echo "/implement issue #$1 (gh issue view $1). Работай в уже созданной ветке $2. $review Потом запушь ветку (git push -u origin $2) и открой PR: gh pr create --base $3 --head $2. Вопросов не задавай — решай сам и опиши решения в PR. Если задачу сделать нельзя — напиши причину комментарием в issue (gh issue comment $1) и остановись."
}
pr_task() { # $1 — номер PR, $2… — что поправить (пусто — по ревью; @ci — упавшие проверки; @conflicts — конфликт с базой)
  local n=$1; shift
  case "$*" in
    @ci) echo "Почини упавшие проверки PR #$n (ты уже в его ветке): gh pr checks $n, логи упавших — gh run view <id> --log-failed | tail -n 80. Исправь причину, проверь локально, закоммить и запушь. Если падение не связано с изменениями PR — напиши об этом комментарием в PR и остановись."; return ;;
    @conflicts) echo "У PR #$n конфликт с $BASE (ты уже в его ветке). Влей свежую базу: git fetch origin, git merge origin/$BASE, разреши конфликты по смыслу обеих сторон, проверь, закоммить и запушь (без force push). Опиши в комментарии к PR, как разрешил."; return ;;
  esac
  if [ -n "$*" ]; then echo "Поправь PR #$n (ты уже в его ветке): $*. Проверь, закоммить и запушь."
  else echo "Поправь PR #$n (ты уже в его ветке): прочитай ревью и комментарии (gh pr view $n --comments, gh api repos/$REPO/pulls/$n/comments) и упавшие проверки (gh pr checks $n), исправь, проверь, закоммить и запушь. Ответь на комментарии, что сделано."; fi
}
keep_wip() { # незаконченное не стираем: локальный коммит «WIP бота» в ветке задачи (не пушится)
  [ -z "$(git status --porcelain)" ] && return 0
  git add -A && git commit -qm "WIP бота: незаконченная работа" --no-verify && echo '{"type":"bot_note","text":"Незаконченные правки сохранены в ветке — «Продолжить» подхватит их"}'
}
finish_issue() { # $1 — номер, $2 — ветка: метки, поиск PR (в т. ч. уже слитого), итог для панели
  keep_wip "$2"
  gh issue edit "$1" -R "$REPO" --remove-label in-progress >/dev/null 2>&1 || true
  local pr; pr=$(gh pr list -R "$REPO" --head "$2" --state all --json url --jq '.[0].url' 2>/dev/null || true)
  git checkout -q "$BASE"
  printf '{"type":"bot_result","branch":"%s","pr":"%s"}\n' "$2" "$pr"
}
start_issue_branch() { # $1 — номер, $2 — база; печатает имя ветки
  local br="agent/issue-$1"
  git fetch -q origin
  git checkout -q -B "$br" "origin/$2"
  echo "$br"
}

# Панель показывает варианты ответа кнопками (как AskUserQuestion в терминале — сам инструмент в фоне недоступен)
PANEL_PROMPT='Тебя запускают из панели, человек отвечает следующим сообщением. Отвечай коротко.
Когда нужен ответ человека — закончи сообщение вопросом в таком блоке (и сразу закончи ход):
```choices
{"question": "Вопрос целиком, понятный без остального текста?", "multi": false,
 "options": [{"label": "Вариант (Рекомендую)", "description": "что будет, если выбрать"}, {"label": "Другой вариант", "description": "…"}]}
```
2–4 варианта, рекомендуемый — первым с пометкой «(Рекомендую)»; "multi": true — если можно выбрать несколько. Свой ответ человек может написать сам — вариант «Другое» не добавляй. Один блок — один вопрос; несколько независимых вопросов — несколько блоков подряд. Вопрос без готовых вариантов — обычным текстом.'

# ---------- служебные команды для панели (bot ui): поток событий stream-json в stdout ----------
case "$1" in
  _issue)  # _issue N BASE
    setup_repo; fresh_main; size_model "$2"; model_opts cheap
    st=$(gh issue view "$2" -R "$REPO" --json state --jq .state 2>/dev/null || true)
    if [ "$st" = CLOSED ]; then
      printf '{"type":"bot_result","closed":true,"text":"Issue #%s уже закрыт — делать нечего"}\n' "$2"; exit 0
    fi
    br=$(start_issue_branch "$2" "${3:-$BASE}")
    gh issue edit "$2" -R "$REPO" --add-label in-progress --remove-label ready-for-agent >/dev/null 2>&1 || true
    ai_run new 0 "$(issue_task "$2" "$br" "${3:-$BASE}")" || true
    finish_issue "$2" "$br"; exit 0 ;;
  _pr)     # _pr N [текст]
    setup_repo; fresh_main; model_opts cheap
    gh pr checkout -R "$REPO" "$2" >/dev/null
    br=$(git branch --show-current)
    ai_run new 0 "$(pr_task "$2" "${@:3}")" || true
    keep_wip "$br"; git checkout -q "$BASE"
    printf '{"type":"bot_result","branch":"%s"}\n' "$br"; exit 0 ;;
  _continue) # _continue SESSION BRANCH ISSUE — продолжить прерванную работу (сбой, лимит) в той же сессии
    setup_repo; model_opts cheap
    git fetch -q origin; git checkout -q "$3"
    git log -1 --format=%s | grep -q '^WIP бота' && git reset -q --soft HEAD~1   # вернуть незаконченное в рабочую копию
    ai_run resume 0 "$2" \
      "Работа прервалась (сбой связи или лимит). Продолжай с того места, где остановился: сначала git status и git log, чтобы понять, что уже сделано, потом доделай задачу до конца (проверки, push, PR)." || true
    if [ -n "$4" ]; then finish_issue "$4" "$3"; else keep_wip "$3"; git checkout -q "$BASE"; printf '{"type":"bot_result","branch":"%s"}\n' "$3"; fi
    exit 0 ;;
  _new)    # _new "задача" — начало разговора (обсуждение, баг, разбор, свободная задача)
    setup_repo; fresh_main; model_opts
    ai_run new 1 "$2"; exit 0 ;;
  _resume) # _resume SESSION "ответ" — продолжение того же разговора (копию не сбрасываем)
    setup_repo; model_opts
    ai_run resume 1 "$2" "$3"; exit 0 ;;
  _wip)    # после остановки: незаконченное — коммитом «WIP бота» в ветку задачи, копия — снова на main
    setup_repo; br=$(git branch --show-current)
    if [ -n "$br" ] && [ "$br" != "$BASE" ]; then keep_wip "$br" >/dev/null || true; git checkout -q "$BASE" 2>/dev/null || true; fi
    exit 0 ;;
  _status) setup_repo; git status --short; exit 0 ;;
  _reset)  setup_repo; git reset -q --hard && git clean -qfd && git checkout -q "$BASE"; echo ok; exit 0 ;;
esac

# ---------- команды из терминала ----------
setup_repo; fresh_main

run_queue() { # $1 = q | chain, дальше номера issue
  local mode=$1; shift
  local ids=("$@") base=$BASE ok="" failed=""
  if [ "${ids[0]}" = ready ]; then
    ids=($(gh issue list -R "$REPO" --label ready-for-agent --state open --json number --jq 'sort_by(.number) | .[].number'))
    [ ${#ids[@]} -eq 0 ] && { echo "Нет открытых issue с меткой ready-for-agent"; exit 0; }
  fi
  for n in "${ids[@]}"; do case "$n" in ''|*[!0-9]*) echo "Не номер issue: $n"; exit 1 ;; esac; done
  mkdir -p "$LOGS"; BASE_OPTS=("${OPTS[@]}"); caffeinate -i -w $$ & 
  echo "Очередь (${mode}): ${ids[*]}. Компьютер не уснёт, пока идёт работа. Ход дел: bot log"
  for n in "${ids[@]}"; do
    local log="$LOGS/issue-$n.log" br
    echo "▶ #$n $(gh issue view "$n" -R "$REPO" --json title --jq .title)   [$(date +%H:%M)]"
    br=$(start_issue_branch "$n" "$base")
    gh issue edit "$n" -R "$REPO" --add-label in-progress --remove-label ready-for-agent >/dev/null 2>&1 || true
    ( unset SIZE; size_model "$n" >/dev/null; OPTS=("${BASE_OPTS[@]}"); model_opts cheap
      ai_run new 0 "$(issue_task "$n" "$br" "$base")" ) > "$log" 2>&1 || true
    local pr; pr=$(gh pr list -R "$REPO" --head "$br" --state open --json url --jq '.[0].url' 2>/dev/null || true)
    gh issue edit "$n" -R "$REPO" --remove-label in-progress >/dev/null 2>&1 || true
    if [ -n "$pr" ]; then
      echo "  ✓ $pr"; ok="$ok #$n"
      [ "$mode" = chain ] && base="$br"
    else
      echo "  ✗ PR не появился — bot log $n"; failed="$failed #$n"
      if [ "$mode" = chain ]; then echo "  Цепочка остановлена: следующие зависят от этого."; break; fi
    fi
    git reset -q --hard && git clean -qfd
  done
  git checkout -q "$BASE"
  local msg="Готово:${ok:- ничего}${failed:+; не вышло:$failed}"
  echo "$msg"
  osascript -e "display notification \"$msg\" with title \"bot\"" 2>/dev/null || true
}

case "$1" in
  q|chain|log|ui) ;;
  ''|pr|idea|bug|triage|*[!0-9]*) code_mode ;;
esac
case "$1" in
  '')       model_opts; ai_tty ;;
  q|chain)  m=$1; shift; [ $# -eq 0 ] && { usage; exit 1; }; run_queue "$m" "$@" ;;
  pr)       n=$2; case "$n" in ''|*[!0-9]*) usage; exit 1 ;; esac
            gh pr checkout -R "$REPO" "$n" >/dev/null
            model_opts cheap
            ai_tty "$(pr_task "$n" "${@:3}")" ;;
  idea)     model_opts; ai_tty "/grill-with-docs ${*:2}" ;;
  bug)      model_opts; ai_tty "/diagnosing-bugs ${*:2}" ;;
  triage)   model_opts; ai_tty "/triage" ;;
  *[!0-9]*) model_opts; ai_tty "$*" ;;
  *)        size_model "$1" >/dev/null; model_opts cheap
            ai_tty "/implement issue #$1 (gh issue view $1). Когда готово — открой PR." ;;
esac
