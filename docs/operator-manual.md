# Podręcznik operatora PomagierKB

Codzienna pętla pracy z bazą wiedzy — dla operatora/kuratora treści.
(Instalacja/awarie: `docs/deployment.md` i `docs/runbooks/`.)

## 1. Dodawanie treści (/add)

Trzy drogi, wszystkie kończą się SZKICEM w Inboxie (nic nie trafia do bazy bez recenzji):

- **Tekst** — wklej treść (+opcjonalny tytuł i URL źródła jako metadana);
- **Plik** — PDF/DOCX/DOC/MD/TXT… ≤50 MB; skany przechodzą OCR (pol); kolejka
  przetwarza małe pliki przed dużymi, nieudane można **Ponowić** (max 3 próby);
- **Adres URL** — publiczny http(s); system pobiera treść sam (limit 10 MB,
  tylko HTML/tekst/Markdown/PDF/JSON; adresy sieci wewnętrznych są odrzucane).

Bazę docelową dobiera analiza treści (słowa kluczowe routingu z konfiguracji KB);
w recenzji można ją zmienić. **Import setek dokumentów** (folder Drive, CHM, ZIP, żywa baza
SQL) idzie narzędziami hostowymi — `docs/runbooks/new-kb-bulk-import.md`.

## 2. Recenzja Inboxu (/inbox)

- **Zatwierdź** — szkic wejdzie do bazy przy najbliższym buildzie (baza dostaje
  znacznik „zmiany oczekują"); **Odrzuć** wymaga powodu; **Wycofaj** cofa
  zatwierdzony wcześniej wpis (wymaga builda). Uwaga: wycofanie + build sprawia,
  że treść przestaje być wyszukiwalna, ale NIE kasuje węzła z grafu — builder
  działa w trybie UPSERT. Fizyczne usunięcie: `docs/runbooks/purge-document.md`.
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
Ocena odpowiedzi LLM-sędzią (budżetowana): `node tools/eval/judge.mjs`. Iteracja promptu odpowiedzi bez dotykania produkcji: `tools/eval/answer-offline.mjs` (kopia bazy przez backup API, żywy OpenSPG i LLM, zero wierszy answers/luk).

## 8. Ustawienia (/settings)

- LLM (chat/embeddings/openie) — klucze sealowane, podgląd maskowany;
- progi: `learning.threshold` (kiedy powstaje luka), `answer.minScore` (kiedy
  system odmawia zamiast zgadywać — **minimalny cosinus trafności** najlepszego
  wyniku, zakres 0,5–0,99, domyślnie 0,7). Semantyka ZMIENIŁA SIĘ 2026-09-06:
  poprzedni próg liczony na znormalizowanej zgodności kanałów był matematycznie
  martwy i nigdy nie odrzucał. Wartości poniżej 0,5 backend traktuje jak brak
  ustawienia i używa 0,7 — nie da się nimi „poluzować" bramki;
- `answer.rerank` (off/embed/llm), `answer.rewrite` (on/off), `drafts.limits`,
  `chunking`, `ingest.limits` — wartości JSON, działają bez restartu;
- `retention` — **osobna kategoria: ten klucz steruje workerem, który KASUJE dane**
  nieodwracalnie i bez kosza (m.in. pytania w `answers`, `feedback`, zamknięte luki,
  oryginały udanych intake'ów, katalogi eksportu — po 30 dniach nie da się powtórzyć
  builda z gotowego CSV). Skrócenie okresu działa wstecz przy najbliższym biegu.
  Zakres i wartości: `docs/data-governance.md` §2.

Klucz `retention` (domyślnie: logi akcji 90 dni, usage MCP 180, eksporty CSV 30,
bloby nieudanych intake'ów 30) — pełne znaczenie i zakres: `docs/data-governance.md` §2.

## 9. Dane osobowe: usuwanie, offboarding, żądania osób

Treść żyje w kilku miejscach naraz (SQLite, graf OpenSPG, MinIO, pliki, backupy),
więc „usunięcie" to procedura, nie jeden przycisk. Komplet:
**`docs/data-governance.md`** — inwentarz danych, okresy retencji, procedury:

- **usunięcie dokumentu** — §3.1 (Odrzuć/Wycofaj → build → graf w Neo4j i obiekt
  w MinIO trzeba sprzątnąć osobno: builder działa w trybie UPSERT i nie kasuje encji);
- **offboarding / prawo do usunięcia** — §3.2 (Authentik → Wyłącz konto → Anonimizuj;
  anonimizacja wymaga wcześniejszego wyłączenia i jest nieodwracalna);
- **żądanie dostępu i sprostowania** — §3.3;
- **wyzwalacze DPIA** — §5.

**Pamiętaj:** snapshoty backupu zawierają dane do ~186 dni i nie są modyfikowane wstecz —
przy każdym żądaniu usunięcia trzeba to zakomunikować.
