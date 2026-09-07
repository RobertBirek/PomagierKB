# Runbook: diagnoza awarii backupu

Sygnały: alert `kag-alert@kag-backup.service` / `…verify.service`, kokpit panelu
„Backup (świeżość)" na żółto/czerwono, cisza push-monitora Kumy.

**Push-monitory istnieją od 2026-09-07** (wcześniej ten runbook obiecywał sygnał, którego nie
było — Kuma miała 0 monitorów). Są dwa, oba w Uptime Kumie:

| Monitor | Pinguje | Okno ciszy | Co znaczy alarm |
|---|---|---|---|
| `Backup nocny — dead-man's switch` | `backup.sh` przy `ok:true` | 26 h | backup nie wystartował, zawisł, albo padł przed zapisem statusu |
| `Weryfikacja odtwarzania — dead-man's switch` | `verify_backup.sh` przy `ok:true` | 8 dni | tygodniowa weryfikacja nie biegła albo nie przeszła |

To sygnał **komplementarny** do `OnFailure`: alert systemd łapie „unit wystartował i padł",
push-monitor łapie „unit w ogóle nie wystartował" — timer wyłączony, host padł, `flock` po
zawieszonym biegu. URL-e (`BACKUP_PING_URL`, `VERIFY_PING_URL`) są w `/etc/kag/alerts.env`
(0600), ładowanym przez oba unity. Konfigurację monitorów odtwarza
`deploy/scripts/kuma_seed_monitors.sh` — baza Kumy NIE wchodzi do snapshotu.

## Szybka diagnoza

```bash
systemctl status kag-backup.service kag-backup-verify.service
journalctl -u kag-backup.service --since "-2 days" | tail -50
cat /srv/kag-data/kag/panel/backup-status.json            # stamp/ok/missingRequired
cat /srv/kag-data/kag/panel/backup-verify-status.json     # ok + nazwy checków, które padły
LATEST=$(ls -1d /srv/kag-data/backups/nightly/2*/ | tail -1); cat "${LATEST}_manifest.json"
ls -1t /srv/kag-data/backups/verify/verify-*.json | head -1 | xargs jq '.checks[] | select(.ok==false)'
```

`verify_backup.sh` odtwarza KAŻDY datastore na efemerycznym kontenerze `--network none`
(MySQL, Neo4j z hot-tara, MinIO, Postgres Authentika) i sprawdza warstwę aplikacyjną
SQLite (migracje, `kb_registry`, `verifyChain` audytu). Do szybkiej diagnostyki bez
odtworzeń: `verify_backup.sh --quick`. Konkretny snapshot: `--snapshot <katalog>`.

Kontrakt: manifest `ok:false` + exit 1, gdy brakuje KTÓREGOKOLWIEK artefaktu
wymaganego (mysql, neo4j, minio, **panel.sqlite**, authentik-pg) — lista w
`missingRequired`.

## Typowe przyczyny

| Objaw | Przyczyna | Naprawa |
|---|---|---|
| `missingRequired: ["panel.sqlite"]` | kontener kag-panel nie działa / zła ścieżka DB | `docker start kag-panel`; ścieżka: `PANEL_DB_IN_CONTAINER=/data/db/kag.db` |
| `missingRequired: ["mysql"]` | OpenSPG mysql leży | `docker start release-openspg-mysql`, potem ręczny backup |
| verify: `mysql_restore FAIL` | **wyścig z entrypointem MariaDB** (patrz niżej) albo brak RAM/dysku | `detail` w raporcie zawiera stderr importu — czytaj go zamiast zgadywać |
| verify: `neo4j_restore FAIL` | hot-tar grafu nieodtwarzalny albo bazy nie wstają | sprawdź `neo4jMode`/`buildsRunning` w manifeście; sięgnij po snapshot `cold` (`systemctl start kag-backup-cold.service`) |
| verify: `minio_restore FAIL` | rozjazd poświadczeń `.env` ↔ `.minio.sys` albo ucięty tar | porównaj `MINIO_ROOT_*` z `env-kag.env` w snapshocie |
| verify: `sqlite_app FAIL` z `=BRAK` | backup jest poprawnym, ale PUSTYM plikiem (brak tabel) | dokładnie incydent 2026-09-03 — sprawdź `PANEL_DB_IN_CONTAINER` i czy `kag-panel` działał |
| verify: `sqlite_app FAIL` z `audit=BROKEN@<seq>` | zerwany łańcuch audytu w źródłowej bazie | incydent bezpieczeństwa, nie awaria backupu — patrz `docs/runbooks/` audyt |
| verify: `docs_artifacts FAIL` | runbook/`restore.sh` mówi o pliku, którego nie ma w snapshocie | popraw nazwę w dokumencie albo w `backup.sh` — to bramka przeciw literówkom typu `panel.sqlite3` |
| manifest: `offsite.status: blocked_no_encryption` | jest `BACKUP_OFFSITE_TARGET`, brak odbiorcy szyfrowania | ustaw `BACKUP_AGE_RECIPIENT` (klucz publiczny) w `/etc/kag/alerts.env`; snapshot NIE wyjdzie jawnym tekstem |
| manifest: `neo4jCheckpoint: failed` | `cypher-shell` nie odpowiedział przed hot-tarem | graf w snapshocie jest sprzed ostatniego checkpointu (≤15 min replay) — sprawdź `release-openspg-neo4j` |
| retencja: „miesiąc … nie ma ANI JEDNEGO kompletnego snapshotu" | wszystkie snapshoty miesiąca były wadliwe | napraw backup i wymuś świeży (`systemctl start kag-backup.service`) — po 14 dniach z tego miesiąca nie zostanie nic |
| timer „never ran" | jednostka niezainstalowana | `cp deploy/systemd/* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now kag-backup.timer kag-backup-verify.timer kag-backup-cold.timer` |
| brak alertów mimo awarii | brak webhooka | `printf 'ALERT_WEBHOOK_URL=…\n' > /etc/kag/alerts.env && chmod 600 /etc/kag/alerts.env` |

## Lekcja historyczna (2026-09-06): `mysql_restore` fałszywie FAIL

Poprzednia wersja tej tabeli kazała szukać brakującego `MYSQL_DATABASE` — **to była zła
trop**. Prawdziwy przebieg:

1. Entrypoint obrazu MariaDB uruchamia najpierw **serwer tymczasowy** z `--skip-networking`.
2. Sonda gotowości szła po **sockecie unixowym**, więc `SELECT 1` przechodziło już po ~6 s —
   zanim entrypoint wykonał własne skrypty init (`initdb.sql`, `openspg-initdb.sql`).
3. Import dumpu startował w tym oknie i tworzył tabele `kg_*`; skrypt init entrypointu
   przewracał się na `ERROR 1050 Table 'kg_app' already exists`, `set -e` ubijał kontener
   (exit 1), a `docker exec` dostawał 137.
4. Stderr importu leciał do `/dev/null`, więc raport pokazywał zawsze to samo bezużyteczne
   „import dumpu nie powiódł się". Wynik zależał od timingu: 09-03 12:48 PASS, 09-06 FAIL.

Naprawa w `verify_backup.sh`: sonda i import **wyłącznie po TCP**
(`mysql -h127.0.0.1 --protocol=tcp` — serwer tymczasowy w ogóle nie słucha na TCP),
stderr zachowany w polu `detail` (pierwsze 400 B), jeden retry importu i kontrola
`docker inspect -f '{{.State.Running}}'` po imporcie. Ta sama zasada obowiązuje przy
ręcznym odtwarzaniu (`restore.sh --only mysql`) i przy Postgresie Authentika.

## Po naprawie — ZAWSZE

```bash
systemctl start kag-backup.service && systemctl start kag-backup-verify.service
```

Oba muszą skończyć zielono (verify robi restore-test MySQL + integrity SQLite).

## Lekcja historyczna (2026-09-03)

Literówka ścieżki (`kag.sqlite` vs `kag.db`) sprawiała, że snapshoty NIE zawierały
bazy panelu, a backup raportował sukces. Stąd: zbiór REQUIRED (fail-loudly),
`OnFailure=`, cotygodniowy verify i sonda świeżości w kokpicie. Nie osłabiać.
