---
name: kag-daily-ops
description: Poranny/okresowy przegląd stanu produkcji PomagierKB (backup i kopia off-site na pomagierze, push-monitory Kumy, sonda zewnętrzna, failed unity i timery, bramki jakości baz i nagrobki po przebudowach, luki wiedzy, skan CVE, dysk) zakończony krótkim raportem i listą działań z gotowymi komendami. Używaj ZAWSZE, gdy użytkownik pyta „sprawdź backup", „co dziś", „jaki stan systemu", „czy wszystko działa", „co proponujesz na dzisiaj", wraca po przerwie i chce się zorientować, albo gdy alert (ntfy/Kuma/OnFailure) wymaga triage — także wtedy, gdy pyta tylko o jeden element (np. sam backup), bo elementy są od siebie zależne.
---

# Przegląd operacyjny PomagierKB

Cel: w 2–3 minuty ustalić, co jest nie tak, i podać właścicielowi **komendy do wklejenia**, a nie
opisy. Właściciel pracuje w tym samym terminalu; wszystko, co da się zrobić z hosta, robisz sam
(purge nagrobków, bramka jakości, promocja szkiców, ponowny backup); jemu zostawiasz tylko to,
co wymaga jego rąk (sekrety w menedżerze haseł, konsole zewnętrzne, decyzje biznesowe).

## 1. Zbierz fakty jednym poleceniem

```bash
bash .claude/skills/kag-daily-ops/scripts/status.sh
```

Skrypt jest tylko-do-odczytu i drukuje: timery/failed unity, kontenery nie-healthy, ostatni
snapshot + off-site + verify, ostatnie beaty push-monitorów Kumy, per KB: status/dirty/werdykt
ostatniej bramki (z flagą `stale` = nagrobki), liczbę otwartych luk i pending szkiców, ostatni
skan CVE, dysk. Nie zastępuj go ręcznym grzebaniem — zawiera już wszystkie ścieżki i pułapki
(np. `backup-state.json` ma off-site pod `last.offsite`, beaty Kumy są w UTC).

## 2. Interpretuj (co jest normalne, a co nie)

| Sygnał | Normalne | Działanie |
|---|---|---|
| `off-site: status=ok`, artefakt z dzisiejszą datą (po 03:30) | tak | nic |
| `off-site` stary/`failed` | nie | `journalctl -u kag-backup.service --since -1d \| grep -E "off-site\|błąd"`; na pomagierze `/var/log/kag-offsite.log`; klucz `/etc/kag/ssh/id_offsite`, cel w `alerts.env` (`BACKUP_OFFSITE_TARGET`) — patrz `deploy/offsite/README.md` |
| Push-monitor bez beatu > okna (backup 26 h, off-site 26 h, sonda 15 min, verify 8 dni) | nie | odpowiedni unit/timer na pimie albo pomagierze; sonda zewnętrzna: `ssh pomagier 'systemctl status kag-external-probe.timer; tail /var/log/kag-probe.log'` |
| KB `gate=WARN stale` | po każdej przebudowie/re-imporcie — spodziewane | purge (pkt 3) |
| KB `gate=WARN` bez `stale` | zwykle `superseded_documents` = informacyjne (zastąpione wersje tego samego źródła) | nic |
| KB `dirty=1` | promowane szkice bez builda | `node tools/kb-import/build.mjs --namespace <NS>` (SubiektKB: ~25 min, Neo4j heap 3G; jeśli `topic.csv` trwa >10 min sprawdź `docker stats` Neo4j i `stop-the-world` w `/logs/debug.log` — runbook typowe-awarie §2) |
| `kag-cve-scan` failed / `nowych>0` | sygnał do przeglądu, nie awaria | rozkład per obraz z `/srv/kag-data/security/cve/summary.json` (`new.newByImage`); własne obrazy (`kag-panel`/`kag-mcp`) muszą mieć 0; decyzja + wpis w `docs/ops/cve-baseline-log.md` + `deploy/scripts/cve_scan.sh --update-baseline` (NIGDY z `--image`) + `systemctl reset-failed kag-cve-scan.service` |
| luki otwarte > 0 | to realne pytania bez odpowiedzi | skill `learning-gap-loop` |
| szkice pending > 0 | czekają na recenzję człowieka | pokaż tytuły; promuj tylko gdy właściciel wprost deleguje (`POST /api/v1/drafts/bulk`) |
| dysk `/` > 80 % | nie | runbook typowe-awarie §1; nightly backupy to ~5 GB/noc × 14 dni |

**Dokumentacja opisuje stan z chwili zapisu, nie teraźniejszość.** Zanim wpiszesz „do zrobienia"
punkt z runbooka/audytu/decision-logu (np. „przenieść klucz", „re-baseline oczekiwany"), sprawdź
fakt na hoście: czy plik istnieje (`ls -la`), jaka jest data wpisu vs `git log -1 -- <plik>`,
czy `summary.json`/`backup-state.json` już pokazują nowy stan. W teście z 23.09 agent bez tej
reguły kazał właścicielowi powtórzyć rotację klucza wykonaną trzy godziny wcześniej.

Bezpieczne akcje (wykonuj sam, bez pytania): purge nagrobków, bramka jakości, build brudnej
bazy, `reset-failed`, powtórny backup. Pytaj przed: zmianą obrazów/compose, kasowaniem czegokolwiek
na pomagierze, edycją `/etc/kag/*.env` (zapis może być zablokowany — wtedy podaj komendę właścicielowi).

## 3. Nagrobki i bramka (rutyna po buildach)

```bash
sudo deploy/scripts/purge_graph_nodes.sh --namespace <NS> --limit 4000 --apply   # sprawdź: węzłów w bazie = oczekiwane
node tools/kb-import/quality-gate.mjs <NS>                                         # graph_stale_nodes: OK
```

## 4. Raport dla właściciela

Format (po polsku, zwięźle):

```
**Stan**: <1 zdanie: wszystko OK / co nie działa>
**Zrobione teraz**: <lista, z liczbami: ile nagrobków, jaki werdykt>
**Do zrobienia przez Ciebie**: <numerowane komendy do wklejenia, każda z oczekiwanym wynikiem>
**Otwarte/decyzje**: <rzeczy, które czekają na jego odpowiedź>
```

Zawsze podawaj konkretne polecenia z oczekiwanym wynikiem („ma wypisać `0`"), nie „zrób X w panelu"
— chyba że to naprawdę jest w UI (Inbox, Authentik). Sekretów (klucze, hasła, tokeny) nie
wypisuj w rozmowie; gdy właściciel musi je zobaczyć, każ mu użyć osobnej sesji SSH i wyjaśnij
jednym zdaniem dlaczego (transkrypt).
