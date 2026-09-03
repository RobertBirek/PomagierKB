# Runbook: diagnoza awarii backupu

Sygnały: alert `kag-alert@kag-backup.service` / `…verify.service`, kokpit panelu
„Backup (świeżość)" na żółto/czerwono, cisza push-monitora Kumy.

## Szybka diagnoza

```bash
systemctl status kag-backup.service kag-backup-verify.service
journalctl -u kag-backup.service --since "-2 days" | tail -50
cat /srv/kag-data/kag/panel/backup-status.json            # stamp/ok/missingRequired
LATEST=$(ls -1d /srv/kag-data/backups/nightly/2*/ | tail -1); cat "${LATEST}_manifest.json"
```

Kontrakt: manifest `ok:false` + exit 1, gdy brakuje KTÓREGOKOLWIEK artefaktu
wymaganego (mysql, neo4j, minio, **panel.sqlite**, authentik-pg) — lista w
`missingRequired`.

## Typowe przyczyny

| Objaw | Przyczyna | Naprawa |
|---|---|---|
| `missingRequired: ["panel.sqlite"]` | kontener kag-panel nie działa / zła ścieżka DB | `docker start kag-panel`; ścieżka: `PANEL_DB_IN_CONTAINER=/data/db/kag.db` |
| `missingRequired: ["mysql"]` | OpenSPG mysql leży | `docker start release-openspg-mysql`, potem ręczny backup |
| verify: `mysql_restore FAIL` | patrz journal — kontener testowy wymaga `MYSQL_DATABASE` | już w skrypcie; sprawdź wolny RAM/dysk |
| timer „never ran" | jednostka niezainstalowana | `cp deploy/systemd/* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now kag-backup.timer kag-backup-verify.timer kag-backup-cold.timer` |
| brak alertów mimo awarii | brak webhooka | `printf 'ALERT_WEBHOOK_URL=…\n' > /etc/kag/alerts.env && chmod 600 /etc/kag/alerts.env` |

## Po naprawie — ZAWSZE

```bash
systemctl start kag-backup.service && systemctl start kag-backup-verify.service
```

Oba muszą skończyć zielono (verify robi restore-test MySQL + integrity SQLite).

## Lekcja historyczna (2026-09-03)

Literówka ścieżki (`kag.sqlite` vs `kag.db`) sprawiała, że snapshoty NIE zawierały
bazy panelu, a backup raportował sukces. Stąd: zbiór REQUIRED (fail-loudly),
`OnFailure=`, cotygodniowy verify i sonda świeżości w kokpicie. Nie osłabiać.
