#!/usr/bin/env bash
# backup_state.sh — publikuje dla panelu WOLNY OD SEKRETÓW obraz stanu backupu.
#
# Dlaczego istnieje: kontener panelu ma zamontowany wyłącznie własny katalog danych
# (`/data`, uid 10001) i NIE widzi `/srv/kag-data/backups` (0700 root), nie ma socketu
# dockera ani dostępu do systemd — i mieć nie powinien. Strona /backup potrzebuje jednak
# więcej niż dwa pola, które pisały dotąd `backup.sh` i `verify_backup.sh`. Ten skrypt jest
# tym mostem: czyta manifesty, raporty weryfikacji, timery i dysk, a wypluwa jeden plik
# `backup-state.json`, który panel wyłącznie ODCZYTUJE.
#
# SEKRETY: do pliku trafia FAKT konfiguracji, nigdy wartość. `BACKUP_PING_URL` zawiera token
# push-monitora — publikujemy `true/false`, nie URL. Poświadczenia rclone i klucz prywatny
# age nie są tu nawet czytane. Cel off-site (`rclone://remote:bucket`) sekretem nie jest
# i jedzie wprost, bo bez niego strona nie umiałaby powiedzieć, DOKĄD idzie kopia.
#
# Uruchamiany przez `kag-backup-state.timer` (co 10 min) oraz na końcu `backup.sh`
# i `verify_backup.sh`, żeby po biegu panel pokazywał świeży stan natychmiast, a nie
# do 10 minut później.
#
# Użycie: backup_state.sh [--quiet]
set -uo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1
log() { [[ ${QUIET} -eq 1 ]] || echo "[backup-state] $*"; }
warn() { echo "[backup-state][UWAGA] $*" >&2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KAG_ENV="${REPO_ROOT}/deploy/kag/.env"
env_get() { local v; v=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2-) || true; v=${v%%[[:space:]]#*}; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "${v:-${3:-}}"; }

DATA_ROOT="${DATA_ROOT:-$(env_get "${KAG_ENV}" DATA_ROOT /srv/kag-data)}"
BACKUP_ROOT="${BACKUP_ROOT:-${DATA_ROOT}/backups/nightly}"
VERIFY_DIR="${DATA_ROOT}/backups/verify"
PANEL_DIR="${DATA_ROOT}/kag/panel"
OUT="${PANEL_DIR}/backup-state.json"
ALERTS_ENV="${ALERTS_ENV:-/etc/kag/alerts.env}"

[[ -d "${PANEL_DIR}" ]] || { warn "brak katalogu danych panelu ${PANEL_DIR} — nie ma komu tego czytać"; exit 0; }

# ── Konfiguracja hosta: TYLKO fakty, w podpowłoce, żeby sekrety nie wyciekły do środowiska ──
# Rozdzielane NOWĄ LINIĄ, nie spacją: cel rsync bywa postaci `user@host:/ścieżka ze spacją`,
# a `read -r a b c` rozjechałby wtedy wszystkie kolejne pola.
mapfile -t HOST_FACTS < <(
  set +u
  # shellcheck disable=SC1090
  [[ -f "${ALERTS_ENV}" ]] && . "${ALERTS_ENV}"
  enc="none"
  [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && enc="age"
  [[ -z "${BACKUP_AGE_RECIPIENT:-}" && -n "${BACKUP_GPG_RECIPIENT:-}" ]] && enc="gpg"
  [[ "${BACKUP_OFFSITE_ALLOW_PLAINTEXT:-}" == "true" && "${enc}" == "none" ]] && enc="plaintext"
  printf '%s\n%s\n%s\n%s\n' \
    "${BACKUP_OFFSITE_TARGET:-}" "${enc}" \
    "$([[ -n "${BACKUP_PING_URL:-}" ]] && echo true || echo false)" \
    "$([[ -n "${VERIFY_PING_URL:-}" ]] && echo true || echo false)"
)
OFFSITE_TARGET="${HOST_FACTS[0]:-}"
ENCRYPTION="${HOST_FACTS[1]:-none}"
PING_BACKUP="${HOST_FACTS[2]:-false}"
PING_VERIFY="${HOST_FACTS[3]:-false}"

# Nazwy remote'ów rclone (bez poświadczeń). RCLONE_CONFIG pochodzi z alerts.env, bo unity
# backupu mają ProtectHome=true i nie widzą /root/.config — patrz komentarz w alerts.env.
RCLONE_REMOTES=""
if command -v rclone >/dev/null 2>&1; then
  RCLONE_REMOTES="$(
    set +u
    # shellcheck disable=SC1090
    [[ -f "${ALERTS_ENV}" ]] && . "${ALERTS_ENV}"
    rclone listremotes 2>/dev/null | tr -d ':' | tr '\n' ' '
  )"
fi

# ── Timery i dysk ────────────────────────────────────────────────────────────────────────
to_iso() { # to_iso <data w dowolnym formacie systemd> -> ISO-8601 albo pusto
  local raw="${1:-}"
  [[ -z "${raw}" || "${raw}" == "n/a" || "${raw}" == "0" || "${raw}" == "infinity" ]] && return 0
  date -Is -d "${raw}" 2>/dev/null || true
}

timer_facts() { # timer_facts <unit> -> "unit|enabled|next|last"
  local unit="$1" enabled next last
  enabled="$(systemctl is-enabled "${unit}" 2>/dev/null || echo unknown)"
  # systemd renderuje te pola po ludzku ("Tue 2026-09-08 03:26:29 CEST"), a panel formatuje
  # daty sam — normalizujemy do ISO tutaj, żeby front nie zgadywał formatu ani strefy.
  next="$(to_iso "$(systemctl show "${unit}" -p NextElapseUSecRealtime --value 2>/dev/null)")"
  last="$(to_iso "$(systemctl show "${unit}" -p LastTriggerUSec --value 2>/dev/null)")"
  printf '%s|%s|%s|%s' "${unit}" "${enabled}" "${next}" "${last}"
}
TIMERS=""
for unit in kag-backup.timer kag-backup-verify.timer kag-backup-cold.timer; do
  TIMERS+="$(timer_facts "${unit}")"$'\n'
done

DISK_FREE="$(df -B1 --output=avail "${DATA_ROOT}" 2>/dev/null | tail -1 | tr -d ' ')"
DISK_PCT="$(df --output=pcent "${DATA_ROOT}" 2>/dev/null | tail -1 | tr -d ' %')"

# Wyzwalanie z panelu działa tylko wtedy, gdy jednostka .path jest AKTYWNA — sama obecność
# pliku nic nie znaczy, a strona nie może obiecywać przycisku, który nic nie zrobi.
TRIGGER_SUPPORTED=false
systemctl is-active --quiet kag-backup-request.path 2>/dev/null && TRIGGER_SUPPORTED=true

# ── Złożenie JSON-a (python3: ręczne sklejanie JSON-a to prosta droga do pliku, którego
#    panel nie sparsuje przy pierwszym cudzysłowie w komunikacie ostrzeżenia) ─────────────
BACKUP_ROOT="${BACKUP_ROOT}" VERIFY_DIR="${VERIFY_DIR}" PANEL_DIR="${PANEL_DIR}" \
OFFSITE_TARGET="${OFFSITE_TARGET}" ENCRYPTION="${ENCRYPTION}" \
PING_BACKUP="${PING_BACKUP}" PING_VERIFY="${PING_VERIFY}" RCLONE_REMOTES="${RCLONE_REMOTES}" \
TIMERS="${TIMERS}" DISK_FREE="${DISK_FREE:-}" DISK_PCT="${DISK_PCT:-}" \
TRIGGER_SUPPORTED="${TRIGGER_SUPPORTED}" \
python3 - "${OUT}.tmp" <<'PY'
import json, os, re, subprocess, sys
from datetime import datetime, timezone

out_path = sys.argv[1]
backup_root = os.environ["BACKUP_ROOT"]
verify_dir = os.environ["VERIFY_DIR"]
panel_dir = os.environ["PANEL_DIR"]

STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{6}$")

def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None

def dir_size(path):
    try:
        return int(subprocess.run(["du", "-sb", path], capture_output=True, text=True,
                                  timeout=30).stdout.split()[0])
    except Exception:
        return None

# ── Snapshoty ────────────────────────────────────────────────────────────────────────────
try:
    names = sorted(n for n in os.listdir(backup_root) if STAMP_RE.match(n))
except Exception:
    names = []

snapshots = []
for name in names:
    manifest = read_json(os.path.join(backup_root, name, "_manifest.json")) or {}
    snapshots.append({
        "stamp": name,
        "sizeBytes": dir_size(os.path.join(backup_root, name)),
        "ok": manifest.get("ok") if isinstance(manifest.get("ok"), bool) else None,
        "neo4jMode": manifest.get("neo4jMode") if isinstance(manifest.get("neo4jMode"), str) else None,
        "monthly": False,
        "_manifest": manifest,
    })

# Który snapshot przeżyje retencję miesięczną — MUSI odpowiadać prune_snapshots() w backup.sh:
# pierwszy KOMPLETNY zimny w miesiącu, a gdy zimnego nie ma, pierwszy kompletny w ogóle.
monthly_pick = {}
for snap in snapshots:
    if snap["ok"] is not True:
        continue
    month = snap["stamp"][:7]
    current = monthly_pick.get(month)
    if current is None:
        monthly_pick[month] = snap
    elif snap["neo4jMode"] == "cold" and current["neo4jMode"] != "cold":
        monthly_pick[month] = snap
for snap in monthly_pick.values():
    snap["monthly"] = True

last_manifest = snapshots[-1]["_manifest"] if snapshots else {}
last_snapshot = snapshots[-1] if snapshots else None
for snap in snapshots:
    snap.pop("_manifest", None)

# Świeżość bierzemy z pliku statusu pisanego przez backup.sh — on jeden zna moment
# ZAKOŃCZENIA biegu; nazwa katalogu to moment startu.
status = read_json(os.path.join(panel_dir, "backup-status.json")) or {}

last = None
if last_snapshot is not None or status:
    offsite = last_manifest.get("offsite") if isinstance(last_manifest.get("offsite"), dict) else {}
    last = {
        "stamp": status.get("stamp") or (last_snapshot or {}).get("stamp"),
        "createdAt": status.get("createdAt"),
        "ok": status.get("ok") if isinstance(status.get("ok"), bool) else (last_snapshot or {}).get("ok"),
        "sizeBytes": (last_snapshot or {}).get("sizeBytes"),
        "coreArtifacts": status.get("coreArtifacts"),
        "missingRequired": [m for m in status.get("missingRequired", []) if isinstance(m, str)],
        "warnings": [w for w in last_manifest.get("warnings", []) if isinstance(w, str)],
        "neo4jMode": (last_snapshot or {}).get("neo4jMode"),
        "offsite": {
            "target": offsite.get("target") or None,
            "status": offsite.get("status") or None,
            "encryption": offsite.get("encryption") or None,
            "artifact": offsite.get("artifact") or None,
        },
    }

# ── Weryfikacja: pełny raport (z detalami checków), fallback na podsumowanie ──────────────
verify = None
try:
    reports = sorted(n for n in os.listdir(verify_dir) if n.startswith("verify-") and n.endswith(".json"))
except Exception:
    reports = []
if reports:
    report = read_json(os.path.join(verify_dir, reports[-1])) or {}
    checks = []
    for c in report.get("checks", []) if isinstance(report.get("checks"), list) else []:
        if isinstance(c, dict) and isinstance(c.get("name"), str):
            checks.append({
                "name": c["name"],
                "ok": c.get("ok") is True,
                "detail": c["detail"] if isinstance(c.get("detail"), str) else None,
            })
    snapshot_dir = report.get("snapshotDir")
    verify = {
        "stamp": reports[-1][len("verify-"):-len(".json")],
        "checkedAt": report.get("checkedAt"),
        "ok": report.get("ok") if isinstance(report.get("ok"), bool) else None,
        "snapshotStamp": os.path.basename(snapshot_dir) if isinstance(snapshot_dir, str) else None,
        "checks": checks,
        "failed": [c["name"] for c in checks if not c["ok"]],
    }
else:
    summary = read_json(os.path.join(panel_dir, "backup-verify-status.json"))
    if isinstance(summary, dict):
        failed = [f for f in summary.get("failed", []) if isinstance(f, str)]
        verify = {
            "stamp": summary.get("stamp"),
            "checkedAt": summary.get("checkedAt"),
            "ok": summary.get("ok") if isinstance(summary.get("ok"), bool) else None,
            "snapshotStamp": summary.get("snapshotStamp"),
            "checks": [{"name": f, "ok": False, "detail": None} for f in failed],
            "failed": failed,
        }

# ── Timery ───────────────────────────────────────────────────────────────────────────────
def usec_to_iso(raw):
    """systemd podaje albo tekst daty, albo mikrosekundy; 0 / 'n/a' = brak."""
    if not raw or raw in ("0", "n/a", "infinity"):
        return None
    if raw.isdigit():
        value = int(raw)
        if value == 0:
            return None
        return datetime.fromtimestamp(value / 1_000_000, tz=timezone.utc).astimezone().isoformat()
    return raw

timers = []
for line in os.environ.get("TIMERS", "").splitlines():
    if not line.strip():
        continue
    parts = line.split("|")
    if len(parts) != 4:
        continue
    unit, enabled, nxt, last_trigger = parts
    timers.append({
        "unit": unit,
        "enabled": True if enabled == "enabled" else (False if enabled in ("disabled", "masked") else None),
        "next": usec_to_iso(nxt),
        "last": usec_to_iso(last_trigger),
    })

def as_int(raw):
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None

panel_config = read_json(os.path.join(panel_dir, "backup-config.json")) or {}

state = {
    "schema": 1,
    "generatedAt": datetime.now().astimezone().isoformat(),
    "last": last,
    "verify": verify,
    "snapshots": snapshots,
    "timers": timers,
    "config": {
        "offsiteTarget": os.environ.get("OFFSITE_TARGET") or None,
        "encryption": os.environ.get("ENCRYPTION") or None,
        "pingBackupConfigured": os.environ.get("PING_BACKUP") == "true",
        "pingVerifyConfigured": os.environ.get("PING_VERIFY") == "true",
        "rcloneRemotes": os.environ.get("RCLONE_REMOTES", "").split(),
        "retentionDays": panel_config.get("retentionDays") if isinstance(panel_config.get("retentionDays"), int) else 14,
        "monthlyRetentionMonths": panel_config.get("monthlyRetentionMonths")
            if isinstance(panel_config.get("monthlyRetentionMonths"), int) else 6,
    },
    "disk": {
        "freeBytes": as_int(os.environ.get("DISK_FREE")),
        "usedPercent": as_int(os.environ.get("DISK_PCT")),
    },
    "triggerSupported": os.environ.get("TRIGGER_SUPPORTED") == "true",
}

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

if [[ ! -s "${OUT}.tmp" ]]; then
  rm -f "${OUT}.tmp"
  warn "nie udało się złożyć stanu — zostawiam poprzedni plik nietknięty"
  exit 1
fi
# 0600 i właściciel panelu: plik leży w katalogu, którego regułą jest 0600 (ustalenie D4-07),
# a panel czyta go jako uid 10001.
chmod 600 "${OUT}.tmp"
chown 10001:10001 "${OUT}.tmp" 2>/dev/null || true
mv "${OUT}.tmp" "${OUT}"
log "stan zapisany: ${OUT}"
