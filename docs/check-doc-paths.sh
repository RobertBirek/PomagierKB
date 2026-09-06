#!/usr/bin/env bash
# check-doc-paths.sh — weryfikacja, że KAŻDA ścieżka repo przywołana w dokumentacji
# faktycznie istnieje. Powstało po audycie, w którym runbooki kierowały operatora
# na nieistniejące pliki i skrypty podczas awarii.
#
# Zakres: docs/**, CLAUDE.md, README.md, .claude/skills/** — kandydatów bierze
# WYŁĄCZNIE z fragmentów w backtickach (`…`), pomija cytaty blokowe i linie
# z mapowaniem „stare → nowe" (świadome odwołania historyczne) oraz nazwy metod MCP.
#
# Użycie:  bash docs/check-doc-paths.sh [katalog-repo]   (domyślnie /kag)
# Wyjście: 0 = wszystkie ścieżki istnieją; 1 = lista braków na stdout.
set -uo pipefail
cd "${1:-/kag}"

# --others: obejmij też pliki jeszcze niescommitowane (nowe dokumenty)
FILES=$(git ls-files --cached --others --exclude-standard \
          'docs/*.md' 'docs/**/*.md' 'CLAUDE.md' 'README.md' '.claude/skills/**/*.md' 2>/dev/null | sort -u)
[ -n "$FILES" ] || FILES=$(find docs .claude/skills -name '*.md' 2>/dev/null; echo CLAUDE.md; echo README.md)
# Raporty audytu to zapis stanu z konkretnej daty i CELOWO cytują ścieżki, których
# jeszcze nie ma (zalecenia „utwórz X") — nie są instrukcją dla operatora.
FILES=$(printf '%s\n' "$FILES" | grep -v '^docs/design/audit-.*\.md$')

miss=0; checked=0
while IFS= read -r doc; do
  [ -f "$doc" ] || continue
  # ścieżki w backtickach: zaczynają się od znanego katalogu repo albo kończą znanym rozszerzeniem
  # pomijamy: cytaty blokowe (> ...) i linie z mapowaniem "stare → nowe" (zapis historyczny)
  grep -vE '^\s*>|→' "$doc" \
    | grep -oE '`[^`]+`' \
    | tr -d '`' \
    | grep -oE '(^|[[:space:](])((apps|packages|deploy|docs|tools|schemas|services|integrations|\.claude|\.github)/[A-Za-z0-9_./@*{}-]+|[A-Za-z0-9_.-]+\.(ts|tsx|mjs|sh|sql|yaml|yml|json|md|css|tpl))' \
    | sed 's/^[[:space:](]*//' \
    | while IFS= read -r p; do
        # odetnij końcowe znaki interpunkcyjne i sufiksy typu :12
        p="${p%%:*}"; p="${p%.}"; p="${p%,}"
        [ -n "$p" ] || continue
        case "$p" in
          *'{'*|*'*'*) continue ;;                       # wzorce/glob — pomijamy
          */) continue ;;
          tools/list|tools/call|server/discover) continue ;;  # nazwy metod MCP, nie ścieżki
        esac
        # ścieżki bez katalogu (np. "package.json") sprawdzamy tylko gdy istnieją gdziekolwiek
        case "$p" in
          */*) target="$p" ;;
          *)   continue ;;
        esac
        printf '%s\t%s\n' "$doc" "$target"
      done
done <<< "$FILES" | sort -u > /tmp/_docpaths.tsv

while IFS=$'\t' read -r doc p; do
  checked=$((checked+1))
  if [ ! -e "$p" ]; then
    echo "BRAK: $p   (przywołane w $doc)"
    miss=$((miss+1))
  fi
done < /tmp/_docpaths.tsv

echo "---"
echo "sprawdzono ścieżek: $(wc -l < /tmp/_docpaths.tsv), brakujących: $miss"
[ "$miss" -eq 0 ]
