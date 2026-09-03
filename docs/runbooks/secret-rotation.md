# Runbook: rotacja sekretów

Kolejność ma znaczenie — kilka sekretów ma stan pochodny (sealowane wartości,
sesje). Wszystkie sekrety żyją w `deploy/{edge,kag}/.env` (0600, poza git).

## TOKEN_ENC_KEY (AES-GCM: klucze LLM w settings, tokeny sesji) — NAJWIĘKSZA pułapka

Zmiana klucza BEZ ponownego zapieczętowania = panel traci dostęp do kluczy LLM
(fail-closed), a wszystkie sesje stają się nieczytelne.

1. Zanotuj aktualne konfiguracje LLM (baseUrl/model — klucz API musisz mieć z
   panelu dostawcy; podgląd w /settings jest maskowany CELOWO).
2. Wygeneruj nowy klucz: `openssl rand -base64 32` → podmień `TOKEN_ENC_KEY`
   w `deploy/kag/.env`.
3. `docker compose -f deploy/kag/compose.yaml up -d panel mcp` (restart obu).
4. Panel → /settings → wpisz PONOWNIE llm.chat / llm.embeddings (seal nowym kluczem).
5. Użytkownicy logują się od nowa (sesje unieważnione — to oczekiwane).
6. `deploy/scripts/smoke.sh` + pytanie testowe na /ask.

## PANEL_SESSION_SECRET

Podmień w `deploy/kag/.env`, restart panelu — wylogowuje wszystkich, nic więcej.

## Klucz LLM u dostawcy (wyciek/rotacja)

Nowy klucz w panelu dostawcy → /settings → zapisz (AlertDialog pokaże podgląd
starego) → „Test połączenia". Stary klucz unieważnij PO teście.

## Klucze MCP (sk-…)

/mcp → menu klucza → **Rotuj** (nowy sekret raz, stary unieważniony, TTL bez
przedłużenia). Kompromitacja: **Unieważnij** i wydaj nowy; wpisy audytu
`mcp.auth_failed` pokażą próby użycia starego (prefiks).

## Sekrety Authentika / OpenSPG (MySQL itd.)

Wymagają procedur własnych usług — patrz `docs/authentik-setup.md` i
`docs/runbooks/openspg-frozen.md`; PO każdej zmianie: nowy backup
(`systemctl start kag-backup.service`), bo snapshoty zawierają kopie .env.
