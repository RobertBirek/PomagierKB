# Konwencja lekcji z sesji agentów (Claude Code → PomagierKB)

Kanał: narzędzie MCP **`kb_submit_draft`** (markdown ≤100 000 znaków, scope `write`).
Draft trafia do Inboxu i przechodzi normalną recenzję człowieka — agent NIGDY nie
pisze do grafu. Status własnych zgłoszeń agent sprawdza przez `kb_draft_status`.

## Format draftu-lekcji

Treść zaczyna się od front-matter YAML:

```markdown
---
kind: lesson | decision | runbook
project: <slug-projektu>            # np. pomagierkb, sklep-x
session_date: YYYY-MM-DD
supersedes: <draftId>               # opcjonalnie: lekcja zastępująca wcześniejszą
---

## Kontekst
Co się działo i dlaczego temat wypłynął (1-3 zdania).

## Problem / decyzja
Co padło / co trzeba było rozstrzygnąć.

## Rozwiązanie / ustalenie
Jak naprawiono; jaka decyzja zapadła i DLACZEGO.

## Inwariant na przyszłość
Jedna reguła, którą następny agent/człowiek ma stosować bez ponownej analizy.
```

Pola obowiązkowe: `kind`, `project`, `session_date`. Tytuł draftu: `[lesson] <teza
w jednym zdaniu>` (analogicznie `[decision]`, `[runbook]`). Tagi: `['lesson',
'project:<slug>', ...merytoryczne]` — mieszczą się w limicie 10.

## Etykieta dedupe

Przed zgłoszeniem agent wykonuje `kb_search` po tezie lekcji w namespace projektu:
- brak trafienia → nowy draft;
- jest wcześniejsza lekcja o tym samym → draft ZASTĘPUJĄCY z `supersedes: <draftId>`
  w front-matter i odnośnikiem w treści (recenzent odrzuci starą przy promocji nowej);
- identyczna treść → `kb_submit_draft` i tak zdeduplikuje po sha256 (zwróci
  istniejący draftId z `duplicate: true`).

## Po stronie panelu

Front-matter draftów `source_type='mcp'` jest parsowany do metadanych widocznych
w Inboxie (chip „Lekcja" + projekt); filtr tagu `lesson` grupuje zgłoszenia z sesji.
Kwoty: 25 draftów/dzień na klucz (globalnie 100) — ustawienie `drafts.limits`.
