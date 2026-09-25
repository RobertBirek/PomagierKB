#!/usr/bin/env bash
# rotate_openspg_embedding_key.sh — DRUGA kopia klucza LLM (docs/runbooks/secret-rotation.md §5):
# rejestr modeli OpenSPG trzyma klucz embeddingów JAWNIE w MariaDB `openspg.kg_user_model.config` (JSON: tablica z jednym obiektem, stąd ścieżki `$[0].…`).
# Po podmianie klucza w panelu (/settings, kopia 1) ten skrypt przepisuje api_key w rejestrze na
# wartość z ustawień panelu (odczyt sealowanego `llm.embeddings` przez TOKEN_ENC_KEY z deploy/kag/.env).
# Klucz NIGDY nie trafia do argv/logu/stdout — porównujemy tylko prefiksy.
# Użycie: deploy/scripts/rotate_openspg_embedding_key.sh [--apply]   (bez --apply = podgląd)
set -euo pipefail
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
cd /kag || exit 1
set -a; . deploy/kag/.env; set +a
[[ -n "${TOKEN_ENC_KEY:-}" ]] || { echo "brak TOKEN_ENC_KEY w deploy/kag/.env" >&2; exit 1; }
# 1. klucz z panelu (sealowany) — do pliku tymczasowego 0600, nie do zmiennej środowiskowej procesów potomnych
TMP="$(mktemp -d)"; chmod 700 "${TMP}"; trap 'rm -rf "${TMP}"' EXIT
node --input-type=module -e '
import Database from "better-sqlite3";
import { unseal } from "/kag/packages/shared/dist/crypto/index.js";
import { writeFileSync } from "node:fs";
const db = new Database("/srv/kag-data/kag/panel/db/kag.db", { readonly: true });
const read = (k) => { const r = db.prepare("SELECT value_json, is_secret FROM settings WHERE key = ?").get(k); if (!r) return null; const v = JSON.parse(r.value_json); return r.is_secret === 1 ? JSON.parse(unseal(v.sealed, process.env.TOKEN_ENC_KEY)) : v; };
const cfg = read("llm.embeddings") ?? read("llm.chat");
if (!cfg?.apiKey) { console.error("brak apiKey w llm.embeddings/llm.chat"); process.exit(1); }
writeFileSync(process.argv[1], cfg.apiKey, { mode: 0o600 });
console.log(`panel: model ${cfg.model}, klucz ${cfg.apiKey.slice(0, 7)}…${cfg.apiKey.slice(-4)}`);
' "${TMP}/key"
NEW="$(cat "${TMP}/key")"
# 2. stan rejestru OpenSPG
ROW="$(docker exec release-openspg-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "select id, JSON_UNQUOTE(JSON_EXTRACT(config,\"$[0].api_key\")), JSON_UNQUOTE(JSON_EXTRACT(config,\"$[0].model\")) from openspg.kg_user_model where JSON_EXTRACT(config,\"$[0].modelType\")=\"embedding\"" 2>/dev/null')"
[[ -n "${ROW}" ]] || { echo "brak modelu embedding w kg_user_model" >&2; exit 1; }
ID="$(printf '%s' "${ROW}" | cut -f1)"; OLD="$(printf '%s' "${ROW}" | cut -f2)"; MODEL="$(printf '%s' "${ROW}" | cut -f3)"
echo "OpenSPG: model #${ID} ${MODEL}, klucz ${OLD:0:7}…${OLD: -4}"
if [[ "${OLD}" == "${NEW}" ]]; then echo "rejestr już ma klucz z panelu — nic do zrobienia"; exit 0; fi
[[ ${APPLY} -eq 1 ]] || { echo "PODGLĄD: klucz w rejestrze różni się od panelu — uruchom z --apply, żeby przepisać"; exit 0; }
# 3. zapis — klucz przez stdin do mysql (nie w argv), JSON_SET zachowuje resztę configu
printf 'UPDATE openspg.kg_user_model SET config = JSON_SET(config, "$[0].api_key", "%s") WHERE id = %s;\n' "${NEW}" "${ID}" \
  | docker exec -i release-openspg-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" 2>/dev/null'
CHK="$(docker exec release-openspg-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "select JSON_UNQUOTE(JSON_EXTRACT(config,\"$[0].api_key\")) from openspg.kg_user_model where id='"${ID}"'" 2>/dev/null')"
[[ "${CHK}" == "${NEW}" ]] && echo "OK: rejestr OpenSPG ma nowy klucz (${NEW:0:7}…${NEW: -4}). Teraz: build StagingSmoke → FINISH, potem unieważnij stary klucz u dostawcy." || { echo "zapis nie zgadza się" >&2; exit 1; }
