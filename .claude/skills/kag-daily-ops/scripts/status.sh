#!/usr/bin/env bash
# status.sh — fakty o stanie PomagierKB w JEDNYM biegu (tylko odczyt, ~10 s). Wynik czyta agent,
# nie człowiek: sekcje z nagłówkami, liczby zamiast opisów, brak sekretów. Uruchamiaj z /kag jako root.
set -uo pipefail
cd /kag || exit 1
DB=/srv/kag-data/kag/panel/db/kag.db
echo "## data: $(date -Is)"
echo "## timery/unity"
systemctl list-timers --no-pager 2>/dev/null | grep -E "kag-" | awk '{print $1" "$2" "$3" -> "$NF}'
echo "failed: $(systemctl --failed --no-legend --no-pager 2>/dev/null | grep -c kag- || true) (kag-*)"; systemctl --failed --no-legend --no-pager 2>/dev/null | grep kag- || true
echo "## kontenery (nie-healthy)"
docker ps --format '{{.Names}} {{.Status}}' | grep -E "kag-|release-|edge-" | grep -v "(healthy)" || echo "wszystkie healthy"
echo "## backup / off-site"
python3 - <<'PY'
import json
s=json.load(open('/srv/kag-data/kag/panel/backup-state.json'))
l=s.get('last',{}); o=l.get('offsite',{}) or {}
print(f"ostatni snapshot: {l.get('stamp')} ok={l.get('ok')} size={l.get('sizeBytes')} warnings={l.get('warnings')}")
print(f"off-site: status={o.get('status')} artifact={o.get('artifact')} bytes={o.get('archiveBytes')} seconds={o.get('transferSeconds')}")
v=s.get('verify',{}) or {}; print(f"verify: {v}")
PY
echo "## odbiorca off-site (pomagier)"
ssh -o ConnectTimeout=10 -o BatchMode=yes pomagier 'sudo -n sh -c "echo komplety: \$(ls /backups/pim/nightly/*.tar.age 2>/dev/null | wc -l), wolne: \$(df -h --output=avail /backups | tail -1 | tr -d \" \"); tail -1 /var/log/kag-offsite.log; systemctl list-timers --no-pager | grep -E kag-\(offsite\|external\) | cut -c1-58"' 2>/dev/null || echo "pomagier nieosiągalny (WireGuard/SSH) — to samo w sobie jest sygnałem"
echo "## push-monitory Kumy (ostatni beat)"
python3 - <<'PY'
import sqlite3
db=sqlite3.connect('file:/srv/kag-data/edge/kuma/kuma.db?mode=ro', uri=True)
for name,status,t in db.execute("select m.name,h.status,h.time from monitor m join heartbeat h on h.monitor_id=m.id where m.type='push' and h.id in (select max(id) from heartbeat group by monitor_id)"):
    print(f"{ {1:'UP',0:'DOWN',2:'PENDING'}.get(status,status)} {t} {name}")
PY
echo "## bazy wiedzy (rejestr) i ostatnia bramka"
python3 - <<'PY'
import sqlite3, glob, re, os
db=sqlite3.connect('file:/srv/kag-data/kag/panel/db/kag.db?mode=ro', uri=True)
for ns,status,dirty in db.execute("select namespace,status,dirty from kb_registry order by namespace"):
    logs=sorted(glob.glob('/srv/kag-data/kag/panel/actions/*/*/*.log'), key=os.path.getmtime)
    verdict='-'
    for p in reversed(logs):
        try: head=open(p,'rb').read(400).decode('utf-8','ignore')
        except: continue
        if f'resource=kb:{ns}' in head and ('build_kb' in head or 'quality_gate' in head):
            txt=open(p,'rb').read().decode('utf-8','ignore'); m=re.findall(r'quality gate: (\w+)', txt); 
            stale='stale' if 'graph_stale_nodes: WARN' in txt else ''
            verdict=f"{m[-1] if m else '?'} {stale} ({os.path.basename(p)})"; break
    print(f"{ns}: status={status} dirty={dirty} gate={verdict}")
print("luki otwarte:", db.execute("select count(*) from learning_gaps where status='open'").fetchone()[0], "| szkice pending:", db.execute("select count(*) from drafts where status='pending'").fetchone()[0])
PY
echo "## CVE (ostatni skan)"
python3 - <<'PY'
import json
s=json.load(open('/srv/kag-data/security/cve/summary.json')); print(f"{s['generatedAt']} nowych={s['new']['newTotal']} (własne={s['new']['newOwnTotal']}) crit={s['totals']['critical']} high={s['totals']['high']}")
PY
echo "## dysk"
df -h / /srv 2>/dev/null | awk 'NR>1{print $6" "$5" used, "$4" free"}' | sort -u
