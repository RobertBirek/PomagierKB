#!/usr/bin/env bash
# PostToolUse (Edit|Write) hook: eslint --fix na edytowanym pliku TS/TSX (szybki, per-plik;
# pełny lint/typecheck pozostaje bramką ręczną) + przypomnienie o pułapce bind-mounta
# Caddyfile (exit 2 = stderr wraca do Claude jako feedback, bez blokowania edycji).
set -u
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$file" ] && exit 0

case "$file" in
  */deploy/edge/Caddyfile)
    echo "UWAGA: deploy/edge/Caddyfile to bind-mount POJEDYNCZEGO pliku — edycja podmienia inode," >&2
    echo "wiec 'caddy reload' przeladuje STARA wersje. Po edycji wymagany: docker restart edge-caddy" >&2
    echo "(krotka przerwa wszystkich vhostow) i weryfikacja 'curl -s -o /dev/null -w %{http_code} https://kag.ilovelighting.sanok.pl/mcp'." >&2
    exit 2
    ;;
  *.ts|*.tsx)
    repo=$(cd "$(dirname "$0")/../.." && pwd)
    case "$file" in
      "$repo"/*) cd "$repo" && npx eslint --fix "$file" >/dev/null 2>&1 || true ;;
    esac
    ;;
esac
exit 0
