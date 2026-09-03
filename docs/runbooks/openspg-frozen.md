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
