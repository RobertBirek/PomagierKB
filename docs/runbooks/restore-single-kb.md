# Runbook: odtworzenie POJEDYNCZEJ bazy wiedzy

Scenariusz: jedna KB uszkodzona/skasowana w grafie, reszta systemu zdrowa.
(Pełne odtworzenie serwera: `disaster-recovery.md` — UWAGA na spójność dat snapshotów.)

Kluczowa własność systemu: **SQLite panelu jest źródłem prawdy o treści**
(promowane szkice + mirror chunków), a graf OpenSPG jest ODTWARZALNY z eksportu.

## A. Graf uszkodzony, SQLite zdrowy (najczęstsze)

1. Panel → /kb → baza → **Buduj** z flagą force (albo
   `POST /api/v1/kbs/<ns>/build {"force":true}`): pełny re-eksport CSV z
   promowanych szkiców + ponowny upload + joby buildera — graf odtwarza się
   w całości, id są deterministyczne (UPSERT).
2. Po buildzie: kontrola jakości (werdykt na wierszu) + `npm run eval`.

## B. Rekordy KB skasowane też w SQLite

1. Wyciągnij z ostatniego snapshotu kopię panelu:
   `zstd -d < …/panel.sqlite` → plik tymczasowy (NIE podmieniaj produkcyjnego!).
2. Przenieś TYLKO wiersze tej KB (drafts + chunks_mirror + kb_registry) przez
   `sqlite3 ATTACH`:
   ```sql
   ATTACH '/tmp/panel-restore.sqlite' AS old;
   INSERT OR IGNORE INTO kb_registry SELECT * FROM old.kb_registry WHERE namespace='<Ns>';
   INSERT OR IGNORE INTO drafts       SELECT * FROM old.drafts       WHERE namespace='<Ns>';
   INSERT OR IGNORE INTO chunks_mirror SELECT * FROM old.chunks_mirror WHERE namespace='<Ns>';
   ```
   (na kopii przez `docker exec kag-panel node -e …` albo host z sqlite3;
   panel na czas operacji zatrzymany: `docker stop kag-panel kag-mcp`).
3. Start paneli, potem **A** (force build).

## C. Projekt OpenSPG nie istnieje (skasowany w grafie)

`create_kb` jest idempotentne: panel → utwórz KB o TYM SAMYM namespace —
provisioning odnajdzie/odtworzy projekt (embedding model musi się zgadzać
z zamrożonym `vector_model_id`; preflight to wymusi). Potem **A**.

## Weryfikacja końcowa

- `/kb`: liczby dokumentów/chunków zgodne z oczekiwaniem; werdykt jakości OK;
- `kb_search`/panel /ask znajduje znaną treść tej bazy;
- `npm run eval` (goldens tej KB) zielony.
