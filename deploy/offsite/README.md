# Kopia off-site backupu — strona odbiorcy (host pomagier)

Pim wysyła każdej nocy JEDEN zaszyfrowany plik `<STAMP>.tar.age` + jawny sidecar
`<STAMP>._manifest.json` (`deploy/scripts/backup.sh`, sekcja 11) do `kagbackup@10.90.0.3:/`
(`BACKUP_OFFSITE_TARGET` w `/etc/kag/alerts.env` na pim, klucz `/etc/kag/ssh/id_offsite`,
odcisk hosta w `/etc/kag/ssh/known_hosts`). Decyzja: `docs/design/PLAN.md` (2026-09-23).

Zasada: **pim może tylko dopisywać**. Odczyt, nadpisanie i kasowanie robi wyłącznie root
odbiorcy — kompromitacja pim nie kasuje kopii, a klucz prywatny `age` nie leży na żadnym z hostów.

## Instalacja na odbiorcy (raz, jako root)

```bash
useradd --system --home-dir /backups/pim --create-home --shell /bin/sh kagbackup   # /bin/sh: rrsync potrzebuje powłoki
mkdir -p /backups/pim/nightly /backups/pim/.ssh
# klucz publiczny z pim: /etc/kag/ssh/id_offsite.pub
printf 'restrict,command="/usr/bin/rrsync -wo -no-del -no-overwrite /backups/pim/nightly" %s\n' "$(cat id_offsite.pub)" > /backups/pim/.ssh/authorized_keys
chown -R kagbackup:kagbackup /backups/pim; chmod 750 /backups/pim; chmod 700 /backups/pim/.ssh /backups/pim/nightly; chmod 600 /backups/pim/.ssh/authorized_keys
install -m 0755 kag-offsite-prune.sh /usr/local/sbin/
install -m 0644 kag-offsite-prune.service kag-offsite-prune.timer /etc/systemd/system/
umask 077; printf 'OFFSITE_PING_URL=%s\n' '<OFFSITE_PING_URL z /etc/kag/alerts.env na pim>' > /etc/kag/offsite.env
systemctl daemon-reload && systemctl enable --now kag-offsite-prune.timer
```

Test z pim (klucz ograniczony): zapis przechodzi, odczyt/`ls`/`--delete` muszą być odrzucone:

```bash
SSH="ssh -i /etc/kag/ssh/id_offsite -o UserKnownHostsFile=/etc/kag/ssh/known_hosts -o IdentitiesOnly=yes -o BatchMode=yes"
rsync -rt -e "$SSH" /tmp/probe.txt kagbackup@10.90.0.3:/probe.txt          # OK
rsync -rt -e "$SSH" kagbackup@10.90.0.3:/probe.txt /tmp/                    # code 12 (rrsync -wo)
$SSH kagbackup@10.90.0.3 ls /                                                # "SSH_ORIGINAL_COMMAND does not run rsync"
```

## Co robi `kag-offsite-prune.sh` (timer co godzinę)

1. zamraża (`chattr +i`) komplety starsze niż 15 min — od tej chwili ani kagbackup, ani pomyłka
   po stronie pim niczego nie zmieni;
2. retencja: 7 ostatnich kompletów + najstarszy komplet z każdego z 2 ostatnich miesięcy, nigdy
   mniej niż 2; sieroty (blob bez sidecara > 12 h) usuwane;
3. dead-man's switch: gdy najnowszy komplet ma < 26 h, ≥ 1 GB i `sha256sum` zgadza się
   z `offsite.archiveSha256` z sidecara → ping push-monitora Kumy „Kopia off-site (pomagier)".
   Log: `/var/log/kag-offsite.log`.

Odtwarzanie z tej kopii: `docs/runbooks/disaster-recovery.md`, krok 0b (kopiować jako `robert`,
nie `kagbackup`).
