#!/usr/bin/env bash
# Miesięczne odświeżenie źródeł WWW bazy SubiektKB: e-Pomoc techniczna InsERT + forum.insert.com.pl.
# Crawlery są wznawialne (pobierają tylko nowe artykuły/wątki), konwertery deterministyczne, a upload
# deduplikuje po sha256 — fragment bez zmian nie tworzy szkicu. Zmieniony fragment ma ten sam sourceUrl,
# więc przy buildzie zastępuje starą wersję (precedencja source_ref). Nowe szkice są promowane
# automatycznie TYLKO dla tych dwóch źródeł (treść publiczna producenta/społeczności, kontrola wyrywkowa
# była przy pierwszym imporcie); dokumentacja z Drive i baza MSSQL NIE są odświeżane tym skryptem.
# Uruchomienie: systemd kag-subiektkb-refresh.timer (deploy/systemd/), ręcznie: deploy/scripts/refresh_subiektkb.sh
set -euo pipefail
cd /kag
E=${SUBIEKTKB_IMPORT_DIR:-/srv/kag-data/import/subiektkb}
NS=SubiektKB
LOG="$E/refresh-$(date +%Y%m%d-%H%M).log"
exec > >(tee -a "$LOG") 2>&1
echo "[refresh] start $(date -Is)"

restore_limits() {
  node -e "import('/kag/tools/kb-import/lib/client.mjs').then(async ({PanelClient})=>{const c=await new PanelClient().open();await c.put('/api/v1/settings/drafts.limits',{value:{perDay:100,perSubmitterPerDay:25}});await c.close();})" || true
}
trap restore_limits EXIT

node tools/kb-import/fetch-epomoc.mjs --out "$E/epomoc" --delay-ms 700
node tools/kb-import/prepare-epomoc.mjs --in "$E/epomoc" --out "$E/out/epomoc"
node tools/kb-import/fetch-forum.mjs --out "$E/forum" --delay-ms 600 --max-topic-pages 4
node tools/kb-import/prepare-forum.mjs --in "$E/forum" --out "$E/out/forum"

# Limity na czas importu (przywracane w trap).
node -e "import('/kag/tools/kb-import/lib/client.mjs').then(async ({PanelClient})=>{const c=await new PanelClient().open();await c.put('/api/v1/settings/drafts.limits',{value:{perDay:1500,perSubmitterPerDay:1500}});await c.close();})"

# state.json pamięta fragmenty już wysłane; zmieniona treść = nowy sha256 = nowy szkic (stary sourceUrl).
for src in epomoc forum; do
  node tools/kb-import/upload.mjs --dir "$E/out/$src"
  node tools/kb-import/promote.mjs --dir "$E/out/$src" --namespace "$NS"
done

# Build tylko gdy coś doszło (dirty=1 po promocji); quality gate w build.mjs.
if node -e "const D=require('/kag/node_modules/better-sqlite3');const db=new D('/srv/kag-data/kag/panel/db/kag.db',{readonly:true});process.exit(db.prepare(\"select dirty from kb_registry where namespace=?\").get('$NS').dirty?0:1)"; then
  node tools/kb-import/build.mjs --namespace "$NS"
else
  echo "[refresh] brak zmian — build pominięty"
fi
echo "[refresh] koniec $(date -Is)"
