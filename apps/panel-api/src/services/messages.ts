import { ERROR_CODES } from '@pomagierkb/shared/errors';

/**
 * SŁOWNIK KOMUNIKATÓW PL (PLAN Faza 3.5): mapowanie kodów stanów technicznych
 * (statusy akcji, statusy builder joba OpenSPG, etapy intake, kody preflight,
 * kody błędów AppError) na ludzkie komunikaty z opcjonalną akcją naprawczą.
 *
 * Czysta logika bez frameworka — testowana na kompletność: każdy kod z
 * eksportowanych stałych MUSI mieć wpis (test/actions-messages.test.ts).
 * humanize() NIGDY nie zwraca surowego kodu — nieznany kod dostaje etykietę
 * 'status techniczny: <kod>'.
 */

export interface HumanMessage {
  /** Krótka etykieta po polsku (do badge/tabeli). */
  label: string;
  /** Dłuższy opis dla użytkownika (tooltip/szczegóły). */
  description?: string;
  /** Sugerowana akcja naprawcza ("co mam teraz zrobić?"). */
  action?: string;
}

/** Statusy wiersza actions (shared repos/actions.ts — ActionStatus). */
export const ACTION_STATUSES = ['running', 'success', 'error', 'cancelled'] as const;

/** Statusy builder joba OpenSPG (aktywne INIT/WAITING/RUNNING + terminalne). */
export const BUILDER_JOB_STATUSES = [
  'PENDING',
  'INIT',
  'WAITING',
  'RUNNING',
  'FINISH',
  'ERROR',
  'SKIP',
  'TERMINATE',
  'SET_FINISH',
] as const;

/** Etapy intake pipeline'u treści (pipeline-frontend §intakes). */
export const INTAKE_STAGES = [
  'received',
  'extracted',
  'cleaned',
  'analyzed',
  'drafted',
  'failed',
] as const;

/** Kody błędów intake (przyczyny status='failed') — patrz pipeline/extract.ts. */
export const INTAKE_ERROR_CODES = [
  'extraction_below_quality_threshold',
  'invalid_encoding',
] as const;

/** Statusy draftów w Inboxie (shared repos/drafts.ts — DraftStatus). */
export const DRAFT_STATUSES = ['pending', 'promoted', 'rejected', 'withdrawn'] as const;

/** Statusy luk wiedzy (shared repos/learningGaps.ts — GapStatus). */
export const GAP_STATUSES = ['open', 'in_draft', 'resolved', 'ignored'] as const;

/** Etapy odpowiedzi /ask (SSE event 'status' — shared answer AnswerPhase). */
export const ANSWER_PHASES = ['retrieval', 'generating'] as const;

/** Identyfikatory checków preflight — MUSZĄ pokrywać PREFLIGHT_CHECK_IDS z preflight.ts. */
export const PREFLIGHT_CODES = [
  'disk_space',
  'dir_writable',
  'openspg_reachable',
  'kb_active',
  'embedding_model',
  'promoted_drafts',
  'no_running_action',
] as const;

/** Identyfikatory checków quality gate (pipeline/quality-gate.ts, Etap 9). */
export const QUALITY_CHECK_CODES = [
  'export_files_exist',
  'row_count_match',
  'ids_unique_nonempty',
  'indexed_field_limits',
  'referential_integrity',
  'promoted_coverage',
  'builds_finished',
  'duplicate_source_urls',
  'live_search_sanity',
  'dirty_flag',
] as const;

/** Werdykty quality gate (repo quality_reports). */
export const QUALITY_VERDICTS = ['OK', 'WARN', 'FAIL'] as const;

/** Mapa kod → komunikat PL. Klucze wspólne (np. 'error') mają jeden wpis. */
export const MESSAGES: Record<string, HumanMessage> = {
  // ── statusy akcji (actions.status) ──────────────────────────────────────
  running: { label: 'w trakcie', description: 'Akcja jest wykonywana — postęp widoczny na żywo.' },
  success: { label: 'zakończona pomyślnie' },
  error: {
    label: 'zakończona błędem',
    description: 'Akcja nie powiodła się.',
    action: 'Sprawdź log akcji i uruchom ją ponownie po usunięciu przyczyny.',
  },
  cancelled: { label: 'anulowana', description: 'Akcja została przerwana przez operatora.' },

  // ── statusy builder joba OpenSPG ────────────────────────────────────────
  PENDING: { label: 'oczekuje w kolejce', description: 'Builder OpenSPG jeszcze nie zaczął przetwarzania.' },
  INIT: { label: 'job utworzony', description: 'Job buildera został przyjęty i czeka na start.' },
  WAITING: { label: 'czeka na wykonanie', description: 'Job buildera czeka w kolejce OpenSPG.' },
  RUNNING: { label: 'budowanie w toku', description: 'Builder OpenSPG przetwarza plik.' },
  FINISH: { label: 'zbudowano', description: 'Builder OpenSPG zakończył przetwarzanie pliku.' },
  ERROR: {
    label: 'błąd buildera',
    description: 'Builder OpenSPG zgłosił błąd przetwarzania pliku.',
    action: 'Zajrzyj do logu builda i spróbuj ponownie; jeśli problem wraca — sprawdź format eksportu CSV.',
  },
  SKIP: { label: 'pominięto', description: 'Plik był już zbudowany w tej samej wersji (bez zmian).' },
  TERMINATE: {
    label: 'przerwano builder',
    description: 'Job buildera został przerwany po stronie OpenSPG.',
    action: 'Uruchom build ponownie.',
  },
  SET_FINISH: { label: 'oznaczono jako zakończony', description: 'Job buildera zamknięty ręcznie po stronie OpenSPG.' },

  // ── etapy intake ────────────────────────────────────────────────────────
  received: { label: 'przyjęto', description: 'Treść trafiła do kolejki przetwarzania.' },
  extracted: { label: 'wyodrębniono tekst', description: 'Z pliku/URL-a udało się wyciągnąć tekst.' },
  cleaned: { label: 'oczyszczono', description: 'Tekst przeszedł czyszczenie (nagłówki, stopki, śmieci).' },
  analyzed: { label: 'przeanalizowano', description: 'Analiza nadała tytuł, tagi i docelową bazę wiedzy.' },
  drafted: { label: 'szkic utworzony', description: 'Szkic czeka na recenzję w Inboxie.', action: 'Przejdź do Inboxu i zatwierdź lub odrzuć szkic.' },
  failed: {
    label: 'przetwarzanie nieudane',
    description: 'Treści nie udało się przetworzyć.',
    action: 'Sprawdź szczegóły błędu przy wpisie i spróbuj z inną wersją dokumentu.',
  },
  extraction_below_quality_threshold: {
    label: 'za mało tekstu w dokumencie',
    description: 'Ekstrakcja dała zbyt mało czytelnego tekstu — to prawdopodobnie skan bez warstwy tekstowej.',
    action: 'To skan bez tekstu — spróbuj inną wersję pliku (z warstwą tekstową) albo wklej treść ręcznie.',
  },
  invalid_encoding: {
    label: 'nieczytelne kodowanie pliku',
    description: 'Plik tekstowy nie jest poprawnym UTF-8 — nie da się bezpiecznie odczytać treści.',
    action: 'Zapisz plik w kodowaniu UTF-8 (bez BOM) i wyślij ponownie albo wklej treść ręcznie.',
  },

  // ── statusy draftów (Inbox) ─────────────────────────────────────────────
  pending: {
    label: 'czeka na recenzję',
    description: 'Szkic czeka w Inboxie na decyzję człowieka.',
    action: 'Przejrzyj szkic w Inboxie i zatwierdź go albo odrzuć.',
  },
  promoted: {
    label: 'zatwierdzony',
    description: 'Szkic zatwierdzony — trafi do bazy wiedzy przy najbliższym buildzie.',
    action: 'Uruchom build bazy, aby treść trafiła do grafu.',
  },
  rejected: {
    label: 'odrzucony',
    description: 'Szkic odrzucony przez recenzenta — nie trafi do bazy wiedzy.',
  },
  withdrawn: {
    label: 'wycofany',
    description: 'Promocja szkicu została cofnięta przed buildem — treść nie trafi do bazy.',
  },

  // ── statusy luk wiedzy ──────────────────────────────────────────────────
  open: {
    label: 'otwarta',
    description: 'Pytanie bez dobrej odpowiedzi — baza wymaga uzupełnienia.',
    action: 'Użyj „Utwórz szkic”, aby uzupełnić wiedzę w tym temacie.',
  },
  in_draft: {
    label: 'szkic w przygotowaniu',
    description: 'Do luki powstał szkic — czeka na treść i recenzję w Inboxie.',
  },
  resolved: {
    label: 'rozwiązana',
    description: 'Wiedza została uzupełniona (powiązany szkic zatwierdzony).',
  },
  ignored: {
    label: 'zignorowana',
    description: 'Luka oznaczona przez operatora jako nieistotna.',
  },

  // ── kody preflight ──────────────────────────────────────────────────────
  disk_space: {
    label: 'wolne miejsce na dysku',
    description: 'Sprawdzenie, czy na wolumenie danych jest wystarczająco wolnego miejsca.',
    action: 'Zwolnij miejsce na dysku danych (stare logi/eksporty) i spróbuj ponownie.',
  },
  dir_writable: {
    label: 'zapis do katalogu danych',
    description: 'Sprawdzenie, czy katalog danych jest zapisywalny.',
    action: 'Sprawdź uprawnienia wolumenu /data (właściciel i tryb zapisu).',
  },
  openspg_alive: {
    label: 'dostępność OpenSPG',
    description: 'Sprawdzenie, czy serwer OpenSPG odpowiada.',
    action: 'Sprawdź kontener OpenSPG (docker compose ps/logs) i ponów operację.',
  },
  kb_active: {
    label: 'baza wiedzy aktywna',
    description: 'Operacja wymaga bazy w stanie aktywnym.',
    action: 'Najpierw sprowizjonuj bazę (Provision) albo wybierz inną bazę.',
  },
  embedding_matches: {
    label: 'zgodność modelu embeddingów',
    description: 'Model embeddingów projektu OpenSPG nie może się zmienić po utworzeniu.',
    action: 'Przywróć w ustawieniach model embeddingów zapisany w rejestrze tej bazy.',
  },
  no_running_action: {
    label: 'brak trwającej akcji',
    description: 'Na tym zasobie nie może trwać inna akcja tego samego typu.',
    action: 'Poczekaj na zakończenie trwającej akcji albo ją anuluj.',
  },
  openspg_reachable: {
    label: 'dostępność OpenSPG',
    description: 'Sprawdzenie, czy serwer OpenSPG odpowiada przed startem builda.',
    action: 'Sprawdź kontener OpenSPG (docker compose ps/logs) i ponów operację.',
  },
  embedding_model: {
    label: 'zgodność modelu embeddingu',
    description: 'Zamrożony model embeddingu projektu musi zgadzać się z konfiguracją w Ustawieniach — modelu nie wolno zmieniać po utworzeniu projektu.',
    action: 'Przywróć w Ustawieniach (llm.embeddings) model zapisany w rejestrze tej bazy.',
  },
  promoted_drafts: {
    label: 'zatwierdzone szkice do eksportu',
    description: 'Build wymaga co najmniej jednego zatwierdzonego szkicu w tej bazie.',
    action: 'Zatwierdź szkice w Inboxie i uruchom build ponownie.',
  },

  // ── checki quality gate (Etap 9) ────────────────────────────────────────
  export_files_exist: {
    label: 'pliki eksportu na dysku',
    description: 'Każdy plik z manifestu eksportu istnieje i ma zgodną sumę sha256.',
    action: 'Uruchom build ponownie — eksport odtworzy pliki.',
  },
  row_count_match: {
    label: 'zgodność liczby wierszy',
    description: 'Liczba wierszy w pliku CSV zgadza się z manifestem eksportu.',
    action: 'Uruchom build ponownie — plik mógł zostać zmieniony po eksporcie.',
  },
  ids_unique_nonempty: {
    label: 'unikalność identyfikatorów',
    description: 'Kolumna id w plikach eksportu nie zawiera pustych wartości ani duplikatów.',
    action: 'Sprawdź zdublowane tytuły/tagi szkiców i uruchom build ponownie.',
  },
  indexed_field_limits: {
    label: 'limity pól indeksowanych',
    description: 'Pola indeksowane mieszczą się w limitach (content chunka ≤1800, preview ≤800, summary ≤400), a hash i długość zgadzają się z treścią.',
    action: 'Uruchom build ponownie; jeśli problem wraca, zgłoś błąd chunkera.',
  },
  referential_integrity: {
    label: 'spójność referencji',
    description: 'Każdy refId (chunk→dokument, dokument→temat) wskazuje istniejącą encję.',
    action: 'Uruchom build ponownie — komplet plików musi pochodzić z jednego eksportu.',
  },
  promoted_coverage: {
    label: 'pokrycie zatwierdzonych szkiców',
    description: 'Każdy zatwierdzony szkic ma co najmniej jeden chunk w eksporcie.',
    action: 'Sprawdź, czy treść szkicu nie jest pusta, i uruchom build ponownie.',
  },
  builds_finished: {
    label: 'zakończone joby buildera',
    description: 'Każdy niepusty plik eksportu ma zakończony sukcesem job buildera OpenSPG.',
    action: 'Uruchom build ponownie i sprawdź log akcji przy błędach jobów.',
  },
  duplicate_source_urls: {
    label: 'zdublowane adresy źródłowe',
    description: 'Ten sam sourceUrl występuje w więcej niż jednym dokumencie (możliwy duplikat treści).',
    action: 'Przejrzyj dokumenty o wspólnym adresie i wycofaj zbędne szkice.',
  },
  live_search_sanity: {
    label: 'sonda wyszukiwania',
    description: 'Wyszukiwanie w grafie zwraca wyniki dla frazy z zatwierdzonego tytułu (indeks może się jeszcze budować).',
    action: 'Odczekaj kilka minut i uruchom kontrolę jakości ponownie.',
  },
  dirty_flag: {
    label: 'zmiany po ostatnim buildzie',
    description: 'Po ostatnim buildzie zatwierdzono lub wycofano szkice — graf nie odzwierciedla stanu inboxu.',
    action: 'Uruchom build bazy, aby zsynchronizować graf.',
  },

  // ── werdykty quality gate ───────────────────────────────────────────────
  OK: { label: 'bez zastrzeżeń', description: 'Wszystkie sprawdzenia jakości przeszły.' },
  WARN: {
    label: 'z ostrzeżeniami',
    description: 'Sprawdzenia krytyczne przeszły, ale są ostrzeżenia.',
    action: 'Rozwiń raport jakości i przejrzyj ostrzeżenia.',
  },
  FAIL: {
    label: 'niezaliczona kontrola jakości',
    description: 'Co najmniej jedno krytyczne sprawdzenie jakości nie przeszło.',
    action: 'Rozwiń raport jakości, usuń przyczyny błędów i uruchom build ponownie.',
  },

  // ── etapy odpowiedzi /ask (SSE) ─────────────────────────────────────────
  retrieval: {
    label: 'szukam w bazie wiedzy',
    description: 'Trwa wyszukiwanie pasujących fragmentów w bazach wiedzy.',
  },
  generating: {
    label: 'generuję odpowiedź',
    description: 'Model językowy układa odpowiedź na podstawie znalezionych źródeł.',
  },

  // ── kody błędów AppError (koperta {ok:false,error:{code}}) ──────────────
  validation_error: {
    label: 'nieprawidłowe dane wejściowe',
    action: 'Popraw zaznaczone pola formularza i spróbuj ponownie.',
  },
  unauthorized: {
    label: 'wymagane zalogowanie',
    action: 'Zaloguj się ponownie — sesja mogła wygasnąć.',
  },
  forbidden: {
    label: 'brak uprawnień',
    description: 'Twoja rola nie pozwala na tę operację.',
    action: 'Poproś administratora o wyższą rolę, jeśli jej potrzebujesz.',
  },
  csrf_rejected: {
    label: 'żądanie odrzucone (CSRF)',
    action: 'Odśwież stronę panelu i spróbuj ponownie.',
  },
  not_found: { label: 'nie znaleziono zasobu' },
  method_not_allowed: { label: 'niedozwolona metoda HTTP' },
  conflict: {
    label: 'konflikt stanu',
    description: 'Zasób jest w stanie, który nie pozwala na tę operację.',
    action: 'Odśwież widok i sprawdź aktualny stan zasobu.',
  },
  action_already_running: {
    label: 'akcja już trwa',
    description: 'Na tym zasobie trwa już akcja tego samego typu.',
    action: 'Poczekaj na jej zakończenie albo obserwuj jej postęp na liście akcji.',
  },
  payload_too_large: {
    label: 'za duży plik lub treść',
    action: 'Zmniejsz plik albo podziel treść na mniejsze części.',
  },
  unsupported_media_type: {
    label: 'nieobsługiwany format',
    action: 'Użyj obsługiwanego formatu (np. PDF, tekst, URL).',
  },
  preflight_failed: {
    label: 'kontrola wstępna nie przeszła',
    description: 'Operacja zatrzymana, bo warunki wstępne nie są spełnione.',
    action: 'Rozwiń listę sprawdzeń, usuń przyczyny błędów i spróbuj ponownie.',
  },
  rate_limited: {
    label: 'za dużo żądań',
    action: 'Odczekaj chwilę i spróbuj ponownie.',
  },
  internal: {
    label: 'błąd wewnętrzny serwera',
    action: 'Spróbuj ponownie; jeśli problem się powtarza, sprawdź logi panel-api.',
  },
  upstream_error: {
    label: 'błąd usługi zewnętrznej',
    description: 'Usługa, z której korzysta panel (OpenSPG/LLM/Stirling/Tika), zwróciła błąd.',
    action: 'Sprawdź stan usług na stronie systemowej i ponów operację.',
  },
  not_ready: {
    label: 'usługa nie jest gotowa',
    action: 'Odczekaj chwilę — trwa start lub brakuje konfiguracji (sprawdź stronę systemową).',
  },
  upstream_timeout: {
    label: 'przekroczono czas oczekiwania na usługę',
    action: 'Ponów operację; jeśli problem wraca, sprawdź obciążenie usług.',
  },
};

/** Wszystkie kody błędów AppError (do testu kompletności). */
export const APP_ERROR_CODES = Object.keys(ERROR_CODES);

/**
 * Zwraca ludzki komunikat dla kodu technicznego. Nieznany kod NIGDY nie wraca
 * "goły": z fallbackiem → {label: fallback}, bez → 'status techniczny: <kod>'.
 */
export function humanize(code: string, fallback?: string): HumanMessage {
  const known = MESSAGES[code];
  if (known !== undefined) return known;
  if (fallback !== undefined && fallback !== '') return { label: fallback };
  return { label: `status techniczny: ${code}` };
}
