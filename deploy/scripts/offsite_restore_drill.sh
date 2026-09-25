#!/usr/bin/env bash
# offsite_restore_drill.sh — PRÓBA ODTWORZENIA z kopii off-site (pomagier), bez dotykania produkcji.
# Kroki: pobranie kompletu <STAMP>.tar.age + sidecar jako `robert` (klucz write-only pim nie czyta),
# sha256 vs `offsite.archiveSha256` z sidecara, odszyfrowanie kluczem age Z PLIKU (nigdy z argv),
# rozpakowanie do katalogu drillu i pełna weryfikacja `verify_backup.sh --snapshot` (realne
# odtworzenia MySQL/Neo4j/MinIO/Postgres/Kumy w efemerycznych kontenerach --network none).
# Na końcu katalog drillu i plik klucza są niszczone (shred).
# Użycie (jako root, na pim):
#   umask 077; cat > /root/age-drill.key     # wklej 3 linie klucza z menedżera haseł, Ctrl-D
#   deploy/scripts/offsite_restore_drill.sh --key /root/age-drill.key [--stamp <STAMP>] [--keep]
# Bez --stamp bierze najnowszy komplet z pomagiera. Wynik: PASS/FAIL + raport verify w
# ${DATA_ROOT}/backups/verify/verify-<stamp>.json i wpis w /var/log/kag-offsite-drill.log.
set -euo pipefail
REMOTE="${OFFSITE_REMOTE:-pomagier}"                 # alias SSH roota (konto robert, sudo NOPASS)
REMOTE_DIR="${OFFSITE_REMOTE_DIR:-/backups/pim/nightly}"
DATA_ROOT="${DATA_ROOT:-/srv/kag-data}"
DRILL_ROOT="${DATA_ROOT}/backups/drill"
LOG=/var/log/kag-offsite-drill.log
KEY=""; STAMP=""; KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key)   KEY="${2:?podaj plik klucza}"; shift 2 ;;
    --stamp) STAMP="${2:?podaj STAMP}"; shift 2 ;;
    --keep)  KEEP=1; shift ;;
    *) echo "nieznany argument: $1" >&2; exit 2 ;;
  esac
done
log() { printf '%s [drill] %s\n' "$(date -Is)" "$*" | tee -a "${LOG}" >&2; }
die() { log "FAIL: $*"; exit 1; }
[[ -r "${KEY}" ]] || die "brak pliku klucza (--key); wklej klucz age do pliku 0600 i podaj ścieżkę"
grep -q '^AGE-SECRET-KEY-1' "${KEY}" || die "plik klucza nie zawiera linii AGE-SECRET-KEY-1…"
command -v age >/dev/null || die "brak age"
cd /kag || die "brak /kag"
if [[ -z "${STAMP}" ]]; then
  STAMP="$(ssh -o BatchMode=yes "${REMOTE}" "sudo -n ls -1 ${REMOTE_DIR}/*.tar.age 2>/dev/null | sed 's#.*/##; s#\\.tar\\.age##' | sort | tail -1")"
  [[ -n "${STAMP}" ]] || die "na ${REMOTE}:${REMOTE_DIR} nie ma żadnego kompletu"
fi
WORK="${DRILL_ROOT}/${STAMP}"
mkdir -p "${WORK}"; chmod 700 "${DRILL_ROOT}" "${WORK}"
cleanup() {
  shred -u "${KEY}" 2>/dev/null || true
  if [[ ${KEEP} -eq 0 ]]; then rm -rf "${WORK}"; fi
}
trap cleanup EXIT
log "komplet ${STAMP}: pobieram z ${REMOTE} (jako robert, przez sudo cat — kagbackup jest write-only)"
ssh -o BatchMode=yes "${REMOTE}" "sudo -n cat ${REMOTE_DIR}/${STAMP}._manifest.json" > "${WORK}/${STAMP}._manifest.json"
ssh -o BatchMode=yes "${REMOTE}" "sudo -n cat ${REMOTE_DIR}/${STAMP}.tar.age" > "${WORK}/${STAMP}.tar.age"
want="$(sed -n 's/.*"archiveSha256": *"\([0-9a-f]\{64\}\)".*/\1/p' "${WORK}/${STAMP}._manifest.json" | head -1)"
have="$(sha256sum "${WORK}/${STAMP}.tar.age" | cut -d' ' -f1)"
[[ -n "${want}" ]] || die "sidecar bez archiveSha256"
[[ "${want}" == "${have}" ]] || die "sha256 bloba (${have:0:12}) ≠ sidecar (${want:0:12})"
log "sha256 zgodna ($(stat -c %s "${WORK}/${STAMP}.tar.age") B); odszyfrowuję i rozpakowuję"
age -d -i "${KEY}" "${WORK}/${STAMP}.tar.age" | tar -x -C "${WORK}" || die "age/tar nie powiodło się (zły klucz?)"
SNAP="${WORK}/${STAMP}"
[[ -f "${SNAP}/SHA256SUMS" ]] || die "po rozpakowaniu brak ${SNAP}/SHA256SUMS"
(cd "${SNAP}" && sha256sum -c --quiet SHA256SUMS) || die "SHA256SUMS w snapshocie nie zgadzają się"
log "snapshot rozpakowany i spójny — pełna weryfikacja odtwarzania (verify_backup.sh --snapshot)"
if deploy/scripts/verify_backup.sh --snapshot "${SNAP}"; then
  log "PASS: kopia off-site ${STAMP} jest odtwarzalna (raport verify w ${DATA_ROOT}/backups/verify/)"
else
  die "verify_backup.sh zgłosił błędy — patrz raport w ${DATA_ROOT}/backups/verify/"
fi
