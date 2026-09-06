# Runbook: rotacja sekretów

Kolejność ma znaczenie — kilka sekretów ma stan pochodny (sealowane wartości, sesje,
dane w Postgresie). Wszystkie sekrety plikowe żyją w `deploy/{edge,kag}/.env` (0600,
root, poza git). **Nie każdy sekret jest w `.env`** — klucze LLM i klucze MCP żyją w SQLite,
a druga kopia klucza LLM w MariaDB OpenSPG (patrz §Klucz LLM).

Nazwy bywają różne po obu stronach — w nagłówkach podajemy **parę**
`NAZWA_W_.env → NAZWA_W_KONTENERZE` (mapowanie robi `deploy/*/compose.yaml`).

---

## 0. Mapa sekretów — gdzie żyje, jak rotować, co się psuje

| Sekret (`.env` → kontener) | Gdzie żyje | Jak rotować | Co się psuje / co jeszcze wyczyścić |
|---|---|---|---|
| `TOKEN_ENC_KEY` → `TOKEN_ENC_KEY` (panel+mcp) | `deploy/kag/.env` | §1 (pełna procedura — **największa pułapka**) | klucze LLM w settings i tokeny sesji stają się nieczytelne bez ponownego zapieczętowania |
| `PANEL_SESSION_SECRET` → **`SESSION_SECRET`** | `deploy/kag/.env` | §2 | wylogowuje wszystkich; nic więcej |
| `PANEL_INTERNAL_TOKEN` → **`INTERNAL_TOKEN`** (panel **i** mcp) | `deploy/kag/.env` | §3 | invalidate cache kluczy MCP przestaje działać (revoke zadziała dopiero po TTL 60 s) — restartuj **oba** kontenery |
| `PANEL_OIDC_CLIENT_SECRET` → **`OIDC_CLIENT_SECRET`** | `deploy/kag/.env` + provider w Authentiku | §4 | nikt się nie zaloguje do panelu (callback 400/401) |
| Klucz LLM u dostawcy | SQLite `settings` (sealed) **+ MariaDB `kg_user_model` (JAWNIE!)** | §5 — **DWIE kopie** | pominięcie drugiej kopii = martwy albo skompromitowany klucz w builderze |
| Klucze MCP `sk-…` | SQLite `api_keys` (sha256+prefix) | §6 | agenci przestają działać do podmiany klucza |
| `OPENSPG_ACCOUNT` / `OPENSPG_PASSWORD` → te same | `deploy/kag/.env` + konto w OpenSPG | §7 | panel/mcp nie zalogują się do `/v1/*` (provisioning, rejestr modeli) |
| `MYSQL_ROOT_PASSWORD`, `MYSQL_APP_PASSWORD` (→ `SERVER_REPOSITORY_IMPL_JDBC_PASSWORD`) | `deploy/kag/.env` + MariaDB | §8 | serwer OpenSPG nie wstanie |
| `OPENSPG_NEO4J_PASSWORD` (+ `_URLENCODED` → `NEO4J_AUTH`, `CLOUDEXT_*_URL`) | `deploy/kag/.env` + Neo4j/DozerDB | §8 | graf niedostępny; **wymaga zmiany hasła w samej bazie**, nie tylko w env |
| `MINIO_ROOT_PASSWORD` (+ `_URLENCODED` → `CLOUDEXT_OBJECTSTORAGE_URL`) | `deploy/kag/.env` + MinIO | §8 | upload CSV do buildera przestaje działać |
| `AUTHENTIK_SECRET_KEY` | `deploy/edge/.env` | **NIE ROTOWAĆ** — §9 | jest „żonaty" z danymi w Postgresie: utrata sesji i podpisów |
| `AUTHENTIK_PG_PASSWORD` (→ `POSTGRES_PASSWORD` **i** `AUTHENTIK_POSTGRESQL__PASSWORD`) | `deploy/edge/.env` + Postgres | §9 | Authentik nie wstanie; zmieniaj w bazie i w env RAZEM |
| `AUTHENTIK_BOOTSTRAP_PASSWORD` / `AUTHENTIK_BOOTSTRAP_TOKEN` | `deploy/edge/.env` | §9 | używane tylko przy pierwszym starcie — **po initial-setup wyczyść wartości** |
| `ACME_EMAIL` | `deploy/edge/.env` | nie jest sekretem | — |

Po **każdej** zmianie w `.env`: nowy backup (`sudo systemctl start kag-backup.service`),
bo snapshoty zawierają kopie `.env` i stary snapshot nadal ma stary sekret.

---

## 1. TOKEN_ENC_KEY (AES-GCM: klucze LLM w settings, tokeny sesji) — NAJWIĘKSZA pułapka

Zmiana klucza BEZ ponownego zapieczętowania = panel traci dostęp do kluczy LLM
(fail-closed), a wszystkie sesje stają się nieczytelne.

1. Zanotuj aktualne konfiguracje LLM (baseUrl/model — klucz API musisz mieć z
   panelu dostawcy; podgląd w /settings jest maskowany CELOWO).
2. Wygeneruj nowy klucz: `openssl rand -base64 32` → podmień `TOKEN_ENC_KEY`
   w `deploy/kag/.env`.
3. `docker compose -f deploy/kag/compose.yaml up -d panel mcp` (restart obu — oba
   procesy dostają ten sam `TOKEN_ENC_KEY`).
4. Panel → /settings → wpisz PONOWNIE llm.chat / llm.openie / llm.embeddings (seal nowym kluczem).
5. Użytkownicy logują się od nowa (sesje unieważnione — to oczekiwane).
6. `deploy/scripts/smoke.sh` + pytanie testowe na /ask.

## 2. PANEL_SESSION_SECRET → SESSION_SECRET

Podmień w `deploy/kag/.env`, restart panelu — wylogowuje wszystkich, nic więcej.
(W kontenerze zmienna nazywa się `SESSION_SECRET`; mapowanie w `deploy/kag/compose.yaml`.)

## 3. PANEL_INTERNAL_TOKEN → INTERNAL_TOKEN (panel ↔ mcp)

Token współdzielony między panelem a serwerem MCP (kanał cache-invalidate po revoke/rotate
klucza). Podmień w `deploy/kag/.env` i **zrestartuj OBA** kontenery jednocześnie:
`docker compose -f deploy/kag/compose.yaml up -d panel mcp`. Rozjazd = revoke klucza MCP
zaczyna działać dopiero po wygaśnięciu cache (do 60 s), bez błędu widocznego dla operatora.

## 4. PANEL_OIDC_CLIENT_SECRET → OIDC_CLIENT_SECRET

1. Authentik → Providers → `kag-panel-oidc` → wygeneruj nowy Client Secret.
2. Podmień w `deploy/kag/.env`, `docker compose -f deploy/kag/compose.yaml up -d panel`.
3. Test logowania w przeglądarce **zanim** zamkniesz sesję SSH (przy błędzie: break-glass —
   `docs/runbooks/break-glass-authentik.md`).
   Przypomnienie: Redirect URI to `https://kag.ilovelighting.sanok.pl/auth/callback` (BEZ `/api`).

## 5. Klucz LLM u dostawcy (wyciek/rotacja) — **DWIE KOPIE, obie trzeba podmienić**

**Kopia 1 — panel (sealowana):** nowy klucz w panelu dostawcy → /settings → zapisz →
„Test połączenia".

**Kopia 2 — rejestr modeli OpenSPG (JAWNY TEKST):** przy provisioningu pierwszej bazy panel
zarejestrował model embeddingu w serwerze OpenSPG (`POST /v1/model` z `config.api_key`).
Serwer trzyma ten klucz w MariaDB `openspg.kg_user_model.config` **bez szyfrowania**
(zweryfikowane 2026-09-06: 1 wiersz, 0 wartości `ENC(...)`, 1 wartość `sk-…`; `jasypt`
w tym buildzie nic nie szyfruje). Panel tej kopii NIE zarządza.

Jeżeli podmienisz tylko kopię 1 i unieważnisz stary klucz u dostawcy — **builder przestanie
liczyć embeddingi** (błędy 401 z API dostawcy w logach `release-openspg-server`).
Jeżeli tylko unieważnisz stary klucz bez podmiany kopii 2 przy kompromitacji — skompromitowany
klucz zostaje żywy w bazie OpenSPG i w każdym backupie.

Kolejność przy rotacji:
1. wystaw nowy klucz u dostawcy (stary jeszcze aktywny);
2. podmień kopię 1 (panel → /settings → Test połączenia);
3. podmień kopię 2 — rejestracja modelu tym samym `POST /v1/model`, którego używa
   provisioning (`packages/shared/src/openspg/models.ts`, `ensureEmbeddingModel`;
   payload i format `modelId` opisane w `.claude/skills/openspg-api/SKILL.md` §Projekty).
   **Uwaga:** `vector_model_id` bazy jest niezmienialny — nowy wpis modelu musi mieć
   ten sam `model` (`text-embedding-3-small`) i skutkować tym samym `modelId`
   (`<instanceId>@<model>`), inaczej preflight zablokuje build;
4. uruchom build testowej bazy (`StagingSmoke`) i potwierdź `FINISH` — dopiero wtedy
5. unieważnij stary klucz u dostawcy;
6. nowy backup (snapshoty sprzed rotacji nadal zawierają stary klucz — patrz §10).

## 6. Klucze MCP (sk-…)

/mcp → menu klucza → **Rotuj** (nowy sekret raz, stary unieważniony, TTL bez
przedłużenia). Kompromitacja: **Unieważnij** i wydaj nowy; wpisy audytu
`mcp.auth_failed` pokażą próby użycia starego (prefiks). Revoke działa najpóźniej
po 60 s (cache LRU) — natychmiast, jeśli działa kanał `INTERNAL_TOKEN` (§3).

## 7. OPENSPG_ACCOUNT / OPENSPG_PASSWORD (konto produktowe OpenSPG)

Konto używane przez panel i mcp do `/v1/*` (projekty, schematy, rejestr modeli).
1. Zmień hasło w OpenSPG: `POST /v1/accounts/updatePassword` z cookiem zalogowanej sesji,
   body `{"password": sha256(NOWE+"OPENSPG"), "confirmPassword": sha256(NOWE+"OPENSPG")}`
   (procedura i pułapki: `.claude/skills/openspg-api/SKILL.md` §Pierwsze uruchomienie).
2. Podmień `OPENSPG_PASSWORD` w `deploy/kag/.env`, `up -d panel mcp`.
3. `smoke.sh` — sonda `projects/list` musi przejść.

## 8. Sekrety datastore'ów OpenSPG (MySQL / Neo4j / MinIO)

Wspólna zasada: **hasło trzeba zmienić W SAMEJ BAZIE i w `.env`**; podmiana tylko w `.env`
zatrzyma stack. Hasła wklejane do URI (`OPENSPG_NEO4J_PASSWORD`, `MINIO_ROOT_PASSWORD`)
wymagają dodatkowo wariantu `*_URLENCODED`:

```bash
python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' 'NOWE-HASŁO'
```

Kolejność: pełny backup (`systemctl start kag-backup.service`) → zmiana hasła w bazie
(`mysql`/`cypher-shell`/`mc admin user`) → podmiana w `.env` (wraz z `_URLENCODED`) →
`docker compose -f deploy/kag/compose.yaml up -d` → czekaj na healthy → `smoke.sh` + build
testowej bazy. Datastore'y są przypięte digestami i zamrożone — rób to w oknie serwisowym
(`docs/runbooks/openspg-frozen.md`).

## 9. Sekrety Authentika

- **`AUTHENTIK_SECRET_KEY` — NIE ROTUJEMY.** Jest powiązany z danymi w Postgresie;
  zmiana unieważnia sesje i podpisy. Trzymaj kopię w menedżerze haseł. Rotacja =
  faktycznie odbudowa Authentika (patrz `break-glass-authentik.md` §5).
- **`AUTHENTIK_PG_PASSWORD`**: zmień hasło roli w Postgresie i w `.env` (mapuje się na
  `POSTGRES_PASSWORD` kontenera bazy **i** `AUTHENTIK_POSTGRESQL__PASSWORD` server/worker),
  potem `docker compose -f deploy/edge/compose.yaml up -d`.
- **`AUTHENTIK_BOOTSTRAP_PASSWORD` / `_TOKEN`**: używane tylko przy pierwszym starcie.
  Po initial-setup **wyczyść wartości** w `deploy/edge/.env` — inaczej żyją w każdym backupie.
- Hasło `akadmin` i MFA: przez UI Authentika; utrata dostępu → `break-glass-authentik.md` §3.

## 10. Kompromitacja sekretu — gdzie jeszcze leży stara wartość

Rotacja nie wystarcza: stary sekret może żyć w kopiach. **Przejrzyj i wyczyść:**

| Miejsce | Jak długo trzyma | Uwagi |
|---|---|---|
| Snapshoty nocne `/srv/kag-data/backups/nightly/` | **14 dni**, a pierwszy snapshot miesiąca **~186 dni** (`backup.sh`: `RETENTION_DAYS=14`, `MONTHLY_KEEP_DAYS=186`) | zawierają kopie `.env` **i** dump MySQL z jawnym kluczem LLM |
| Archiwum off-site (`BACKUP_OFFSITE_TARGET`) | wg celu | jeżeli włączone — usuń tam też |
| Access log Caddy `/srv/kag-data/edge/caddy/data/access-*.log*` | 5 rolek × 20 MB | nagłówki nie są logowane, ale sprawdź przy podejrzeniu wycieku w URL |
| `docker logs` (json-file) | 3 pliki × 10 MB per kontener | `docker logs release-openspg-server \| grep -i 'sk-'` |
| Raporty sędziego `tools/eval/judge-report-*.json` | bezterminowo w repo/roboczo | mogą zawierać fragmenty konfiguracji |
| Historia powłoki operatora (`~/.bash_history`) | bezterminowo | jeśli sekret był wklejany w komendzie |

Dla klucza LLM dodatkowo: `openspg.kg_user_model` (jawny tekst) — patrz §5 kopia 2.
Po wyczyszczeniu zrób **nowy** backup, żeby najświeższy snapshot zawierał już tylko nowe wartości.
