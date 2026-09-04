# Runbook: OpenSPG jest ZAMROŻONY — co to znaczy operacyjnie

Decyzja projektowa (PLAN.md): obrazy OpenSPG 0.8 przypięte po digestach i NIE
aktualizowane. Powody: brak gwarancji migracji schematu MySQL/Neo4j między
wydaniami, niezweryfikowane zmiany API buildera/search, embedding model projektu
jest niezmienialny (`vector_model_id` w rejestrze + preflight).

## Konsekwencje

- `update_check.sh` może raportować nowsze tagi OpenSPG — to INFORMACJA, nie TODO.
- Poprawki bezpieczeństwa OpenSPG nie przychodzą; mitygacja: port 8887 nigdy na
  hoście, sieć `kag-internal` wewnętrzna, dostęp tylko z paneli.
- DR nie może zależeć od rejestru Aliyun: obrazy archiwizowane lokalnie
  (`deploy/scripts/save_images.sh` → `/srv/kag-data/backups/images/`, odświeżane
  przy miesięcznym zimnym backupie).

## Odtworzenie obrazów bez sieci/rejestru

```bash
zstd -dc /srv/kag-data/backups/images/<obraz>@<digest>.tar.zst | docker load
```

## Gdyby KIEDYŚ zapadła decyzja o upgrade (świadoma operacja, nie rutyna)

1. Pełny backup + zimny snapshot neo4j (`backup.sh --cold-neo4j`) + `verify_backup.sh`.
2. Klon danych na boku: odtworzenie stacka kag na osobnym katalogu DATA_ROOT
   z snapshotu (jak w `disaster-recovery.md`), tam podmiana obrazów i test:
   provisioning istniejącej KB (idempotencja), build force, search/vector, eval.
3. Dopiero po zielonym teście na kopii: okno serwisowe na produkcji, podmiana
   digestów w `deploy/kag/.env`, `compose up -d`, smoke + eval + e2e.
4. Rollback = powrót digestów + odtworzenie mysql/neo4j/minio ze snapshotu
   sprzed operacji (graf i metadane muszą wrócić RAZEM).

## Stan upstreamu (sprawdzony 2026-09-04)

Ostatnie wydanie **v0.8 (2025-06-29)** jest zarazem ostatnim commitem na głównej
gałęzi — projekt od ~14 miesięcy bez aktywności. Nasze obrazy == `latest` w
rejestrze (weryfikacja digestów przez API). Miesięczny raport aktualizacji:
`kag-update-check.timer` (2. dzień, 05:15; powiadomienie na ALERT_WEBHOOK_URL).

## Mitygacja sieciowa (wdrożona — „faza 2" z infra.md)

Port 8887 (bez auth) żyje w wydzielonej sieci `kag-datastores` (OpenSPG+MySQL+
Neo4j+MinIO+panel+mcp). **Tika i Stirling — parsery NIEZAUFANYCH uploadów — nie
mają do niego drogi** (zostały na `kag-internal` z panelem). Test negatywny:
`docker exec kag-stirling curl http://release-openspg-server:8887/` musi paść.

## Rampa zjazdowa (opcja strategiczna, NIE plan)

Gdyby OpenSPG/DozerDB stały się nie do utrzymania: architektura już dziś działa
zdegradowana bez grafu (SQLite = źródło prawdy o treści, FTS5 lokalnie, rerank
`embed` liczy trafność jednym modelem query-time). Naturalna migracja kanału
wektorowego to **sqlite-vec** w tym samym pliku DB — kanały `hybridSearch` są
wymienne (packages/shared/src/answer/retrieval.ts), więc zmiana jest izolowana:
nowy kanał + eksport wektorów przy buildzie, bez dotykania MCP/panelu. Decyzję
podjąć dopiero przy realnym sygnale (awaria bez naprawy / brak kompatybilności OS).
