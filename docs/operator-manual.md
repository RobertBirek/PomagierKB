# Podręcznik operatora PomagierKB

Codzienna pętla pracy z bazą wiedzy — dla operatora/kuratora treści.
(Instalacja/awarie: `docs/deployment.md` i `docs/runbooks/`.)

## 1. Dodawanie treści (/add)

Trzy drogi, wszystkie kończą się SZKICEM w Inboxie (nic nie trafia do bazy bez recenzji):

- **Tekst** — wklej treść (+opcjonalny tytuł i URL źródła jako metadana);
- **Plik** — PDF/DOCX/MD/TXT… ≤50 MB; skany przechodzą OCR (pol); kolejka
  przetwarza małe pliki przed dużymi, nieudane można **Ponowić** (max 3 próby);
- **Adres URL** — publiczny http(s); system pobiera treść sam (limit 10 MB,
  tylko HTML/tekst/Markdown/PDF/JSON; adresy sieci wewnętrznych są odrzucane).

Bazę docelową dobiera analiza treści (słowa kluczowe routingu z konfiguracji KB);
w recenzji można ją zmienić.

## 2. Recenzja Inboxu (/inbox)

- **Zatwierdź** — szkic wejdzie do bazy przy najbliższym buildzie (baza dostaje
  znacznik „zmiany oczekują"); **Odrzuć** wymaga powodu; **Wycofaj** usuwa
  zatwierdzony wcześniej wpis (wymaga builda).
- Filtr **Lekcje** pokazuje wpisy zgłoszone przez agentów z sesji (konwencja:
  `docs/lessons-convention.md`) — mają chip rodzaju (lekcja/decyzja/runbook) i projekt.
- Masowe operacje: zaznacz → pasek na dole (najpierw dry-run z raportem).

## 3. Build bazy (/kb)

„Buduj" po partii promocji: preflight → eksport CSV → joby buildera OpenSPG →
kontrola jakości (werdykt OK/WARN/FAIL na wierszu bazy). **Po buildzie dodaj
2-3 pytania do goldens** (pkt 7) — to jedyny sposób, by regresje wyszukiwania
były widoczne zanim zauważą je użytkownicy.

## 4. Luki wiedzy (/inbox → Luki)

Powstają automatycznie: odmowa odpowiedzi, niska pewność, ocena 👎. Sortuj po
**liczbie zgłoszeń** (najczęściej dopytywane najpierw). Akcje: „Uzupełnij"
(prefill /add), Rozwiąż, Ignoruj — **Ignoruj/Rozwiąż da się cofnąć** (Otwórz ponownie).

## 5. Klucze MCP dla agentów (/mcp)

1. (admin) Profil: które narzędzia i które bazy widzi klucz (NULL = wszystkie aktywne).
2. Klucz: TTL 1-365 dni, scope `read` (wyszukiwanie/odpowiedzi/feedback/status
   draftów/pełne źródła) lub `write` (+zgłaszanie szkiców). **Sekret pokazywany RAZ.**
3. Snippet konfiguracyjny dla Claude Code/Cursora: zakładka „Snippety".
Limity: 60 zapytań/min na klucz (10/min kb_answer), 25 szkiców/dzień na zgłaszającego.

## 6. Zdrowie systemu (/overview)

Kokpit: komponenty (graf, LLM, ekstrakcja, MCP), breakery z auto-recovery, dysk,
**świeżość backupu** (żółte >26 h — sprawdź `journalctl -u kag-backup`), certyfikat
TLS oraz karta **„Jakość odpowiedzi — tydzień"** (odśwież: akcja `quality_answers`).

## 7. Goldens (kotwica jakości wyszukiwania)

`tools/eval/goldens/<Namespace>.jsonl` — po każdej partii promocji dopisz 2-3 wiersze:

```json
{"question":"Jaki jest strumień oprawy X?","expectedIds":["DOC_..."],"namespaces":["TwojaKB"],"expectedNamespace":"TwojaKB"}
{"question":"pytanie spoza bazy","negative":true}
```

Uruchomienie: `DATA_DIR=/srv/kag-data/kag/panel npm run eval` (bramka:
`EVAL_MIN_HIT5=0.8`). Tryb `EVAL_CHANNELS=full` mierzy produkcyjny hybrid.
Ocena odpowiedzi LLM-sędzią (budżetowana): `node tools/eval/judge.mjs`.

## 8. Ustawienia (/settings)

- LLM (chat/embeddings/openie) — klucze sealowane, podgląd maskowany;
- progi: `learning.threshold` (kiedy powstaje luka), `answer.minScore` (kiedy
  system odmawia zamiast zgadywać — znormalizowany top wyszukiwania);
- `answer.rerank` (off/embed/llm), `answer.rewrite` (on/off), `drafts.limits`,
  `chunking`, `ingest.limits`, `retention` — wartości JSON, działają bez restartu.
