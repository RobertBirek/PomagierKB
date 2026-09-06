/**
 * Rozstrzyganie opcji `trustProxy` Fastify — czysta logika (bez frameworka),
 * testowana jednostkowo, bo regresja tutaj jest CAŁKOWICIE NIEMA.
 *
 * Kontekst (audyt D2-01): panel-api ustawiał `trustProxy: 1`. Od fastify 5.x
 * wariant LICZBOWY jest celowo fail-closed — `getTrustProxyFn` zwraca
 * `() => false` (lib/request.js), więc X-Forwarded-For NIGDY nie był czytany:
 * `req.ip` = adres gniazda (kontener edge-caddy). Skutki: jeden wspólny kubełek
 * rate-limitu dla całego świata (10 anonimowych żądań/min blokowało logowanie
 * SSO wszystkim) oraz IP proxy zamiast klienta w sesjach i logach.
 *
 * Poprawka: wariant ADRESOWY (lista CIDR/nazw rozumiana przez proxy-addr).
 * `trustProxy: true` jest ZABRONIONE — pozwoliłoby dowolnemu klientowi podszyć
 * się pod cudze IP przez własny nagłówek X-Forwarded-For.
 */

/**
 * Domyślnie zaufane źródła XFF: pętla zwrotna (testy, dev, healthcheck)
 * i adresy prywatne RFC1918/ULA — czyli pule mostków Dockera, w których
 * siedzi JEDYNY nasz proxy (edge-caddy w edge-net, 172.16.0.0/12).
 * Ruch publiczny trafia do panelu wyłącznie przez Caddy (port nieopublikowany),
 * więc żaden klient z internetu nie znajdzie się w tym zbiorze.
 * Zawężenie do konkretnego adresu: TRUST_PROXY=172.19.0.2
 */
export const DEFAULT_TRUST_PROXY = 'loopback,uniquelocal';

/** Wartości TRUST_PROXY wyłączające zaufanie do XFF (req.ip = adres gniazda). */
const DISABLED_VALUES = new Set(['false', 'off', '0', 'no', 'none']);

/** Wartości, które oznaczałyby „ufaj wszystkim" — odrzucane fail-closed. */
const FORBIDDEN_VALUES = new Set(['true', 'on', '1', 'yes', 'all', '*']);

/** Błąd konfiguracji TRUST_PROXY — proces NIE startuje z ustawieniem podatnym na spoofing. */
export class TrustProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustProxyError';
  }
}

/**
 * Zwraca wartość `trustProxy` dla konstruktora Fastify:
 * - lista adresów/CIDR/nazw (string) — XFF honorowany tylko od tych źródeł;
 * - `false` — XFF ignorowany całkowicie.
 * NIGDY nie zwraca `true` ani liczby (patrz komentarz na górze pliku).
 */
export function resolveTrustProxy(env: Record<string, string | undefined> = process.env):
  | string
  | false {
  const raw = env['TRUST_PROXY'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRUST_PROXY;

  const normalized = raw.trim().toLowerCase();
  if (DISABLED_VALUES.has(normalized)) return false;
  if (FORBIDDEN_VALUES.has(normalized)) {
    throw new TrustProxyError(
      `TRUST_PROXY: '${raw}' oznacza zaufanie do KAŻDEGO źródła — wtedy dowolny klient ` +
        'podszyje się pod cudze IP nagłówkiem X-Forwarded-For. Podaj listę adresów lub ' +
        `CIDR (np. '${DEFAULT_TRUST_PROXY}' albo '172.19.0.2'), lub 'false' aby wyłączyć.`,
    );
  }

  // Lista rozdzielana przecinkami — proxy-addr sam waliduje wpisy przy compile().
  const entries = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (entries.length === 0) return DEFAULT_TRUST_PROXY;
  return entries.join(',');
}
