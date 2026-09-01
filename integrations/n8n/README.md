# Integracja z n8n (v1.5)

KAG wystawia stabilne API + webhooki; n8n odpowiada za orkiestrację (harmonogramy, scraping,
powiadomienia). Zaplanowane szablony workflow (docs/design/PLAN.md → v1.5):

1. `draft-awaiting-review.json` — webhook draft.awaiting_review → e-mail/Telegram do recenzenta
2. `scrape-to-ingest.json` — cron → pobierz stronę/RSS → POST /api/v1/content (klucz serwisowy)
3. `gdrive-to-kag.json` — obserwowany folder Google Drive → nowy plik → upload do KAG
4. `build-failed-alert.json` — webhook build.failed → alert

Do czasu webhooków (outbox, v1.5) integracje mogą pollować GET /api/v1/drafts?status=pending
i GET /api/v1/actions?status=error kluczem serwisowym (konto serwisowe + klucz API w panelu MCP).
