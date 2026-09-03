---
name: kb-lesson
description: Destylacja lekcji/decyzji/runbooka z bieżącej sesji i zgłoszenie jej do bazy wiedzy PomagierKB przez MCP kb_submit_draft (do recenzji w Inboxie). Używaj gdy sesja przyniosła wnioski warte utrwalenia dla przyszłych agentów lub gdy użytkownik prosi „zapisz lekcję/wniosek do bazy".
---

# Zgłoszenie lekcji z sesji do PomagierKB

Wymaga skonfigurowanego klienta MCP PomagierKB (profil z `kb_submit_draft`, klucz
scope `write` — snippet konfiguracyjny na stronie /mcp panelu). Pełna konwencja:
`docs/lessons-convention.md`.

## Kroki

1. **Destyluj** z sesji (nie kopiuj transkryptu!): co padło → root cause → fix →
   **inwariant na przyszłość** (jedna reguła do stosowania bez ponownej analizy).
   Jeśli sesja przyniosła kilka niezależnych wniosków — osobne drafty.
2. **Dedupe**: `kb_search` po tezie w namespace projektu. Jest wcześniejsza wersja →
   przygotuj draft zastępujący z `supersedes: <draftId>`.
3. **Zgłoś** przez `kb_submit_draft`:
   - `namespace`: baza projektu (sprawdź `kb_list`),
   - `title`: `[lesson] <teza>` (lub `[decision]`/`[runbook]`),
   - `content`: front-matter YAML (kind/project/session_date) + sekcje Kontekst /
     Problem / Rozwiązanie / Inwariant — szablon w docs/lessons-convention.md,
   - `tags`: `['lesson', 'project:<slug>']` + 1-3 merytoryczne.
4. **Potwierdź** użytkownikowi: draftId + że trafi do recenzji w Inboxie; los
   zgłoszenia można później sprawdzić `kb_draft_status`.

## Zasady

- Zero sekretów/tokenów/danych osobowych w treści lekcji.
- Lekcja ma być zrozumiała BEZ dostępu do sesji (pełne nazwy plików, komend, wersji).
- Nie zgłaszaj oczywistości ani rzeczy zapisanych już w CLAUDE.md/runbookach repo —
  baza to wiedza PONADPROJEKTOWA lub nieoczywista.
