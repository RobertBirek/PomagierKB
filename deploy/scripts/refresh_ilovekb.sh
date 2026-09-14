#!/usr/bin/env bash
# refresh_ilovekb.sh — cykliczne odświeżenie IloveKB z produkcyjnej instancji Subiekta GT (Magnum_Profi):
# TYLKO słowniki z allow-listy, agregaty z progiem k=10 i lista dostawców-osób prawnych. Katalog schematu,
# konwencje i szablony KPI NIE są regenerowane (dokumenty redakcyjne; ich wpisy w manifeście zostają —
# prepare-instance scala manifest). Poświadczenie: /etc/kag/mssql-ilovelighting.env (0600), przez WireGuard.
# Governance: docs/data-governance.md §1.2 (IloveKB) i §1.3 droga 3. Uruchamiane z timera kag-ilovekb-refresh.
set -euo pipefail
cd /kag
E=${ILOVEKB_IMPORT_DIR:-/srv/kag-data/import/ilovekb}
NS=IloveKB
DB=Magnum_Profi
SB=https://kag.ilovelighting.sanok.pl/src/magnum-profi
export MSSQL_ENV_FILE=${MSSQL_ENV_FILE:-/etc/kag/mssql-ilovelighting.env}
# Allow-lista słowników — jawna, taka sama jak przy pierwszym imporcie 2026-09-14; rozszerzenie = wpis w governance.
ONLY='^sl_(GrupaTw|CechaTw|GrupaKh|CechaKh|Rabat|Magazyn|FormaPlatnosci|StawkaVAT|Panstwo|KrajPochodzenia|Waluta|Kategoria|GrupaDokumentow|KategoriaDokumentu|ModelTw|ModelTowar|RodzajObnizki|PrzyczynaKorekty|Etykieta)$'
echo "[refresh-ilovekb] start $(date -Is)"

restore_limits() {
  node -e "import('/kag/tools/kb-import/lib/client.mjs').then(async ({PanelClient})=>{const c=await new PanelClient().open();await c.put('/api/v1/settings/drafts.limits',{value:{perDay:100,perSubmitterPerDay:25}});await c.close();})" || true
}
trap restore_limits EXIT

mkdir -p "$E/out/schema-live" "$E/out/dicts" "$E/out/docs"
node tools/mssql-introspect/dump-dictionaries.mjs "$DB" --out "$E/out/schema-live" --only "$ONLY"
node tools/mssql-introspect/dump-aggregates.mjs --out "$E/out/schema-live" --k 10
node tools/mssql-introspect/dump-suppliers.mjs --out "$E/out/schema-live"
node tools/kb-import/prepare-dicts.mjs --dicts "$E/out/schema-live/dictionaries.json" \
  --docs /srv/kag-data/import/subiektkb/ext/dbdoc/Dokumentacja_DB.xml --out "$E/out/dicts" \
  --product "Subiekt GT ($DB)" --source-base "$SB"
node tools/kb-import/prepare-instance.mjs --aggregates "$E/out/schema-live/aggregates.json" \
  --suppliers "$E/out/schema-live/suppliers.json" --out "$E/out/docs" --source-base "$SB" --k 10

# Bramka: żaden wygenerowany plik nie może zawierać adresu hosta bazy.
if grep -rlE '192\.168\.|INSERTGT|DESKTOP-' "$E/out/dicts" "$E/out/docs" >/dev/null; then
  echo "[refresh-ilovekb] BŁĄD: adres hosta w treści — przerywam" >&2; exit 3
fi

node -e "import('/kag/tools/kb-import/lib/client.mjs').then(async ({PanelClient})=>{const c=await new PanelClient().open();await c.put('/api/v1/settings/drafts.limits',{value:{perDay:1500,perSubmitterPerDay:1500}});await c.close();})"
for src in dicts docs; do
  node tools/kb-import/upload.mjs --dir "$E/out/$src"
  node tools/kb-import/promote.mjs --dir "$E/out/$src" --namespace "$NS"
done
if node -e "const D=require('/kag/node_modules/better-sqlite3');const db=new D('/srv/kag-data/kag/panel/db/kag.db',{readonly:true});process.exit(db.prepare(\"select dirty from kb_registry where namespace=?\").get('$NS').dirty?0:1)"; then
  node tools/kb-import/build.mjs --namespace "$NS"
else
  echo "[refresh-ilovekb] brak zmian — build pominięty"
fi
echo "[refresh-ilovekb] koniec $(date -Is)"
