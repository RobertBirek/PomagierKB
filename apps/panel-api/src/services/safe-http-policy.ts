/**
 * Polityka safe_http (CZYSTA logika, vitest) — walidacja URL-i i klasyfikacja
 * adresów IP pod ingest z sieci (pipeline-frontend §216). Fail-closed: wszystko,
 * co nie jest jawnie publicznym http(s) na porcie 80/443, jest odrzucane.
 * Sieciowa część (DNS-pinning, fetch) w safe-http.ts.
 */

export const FETCH_MAX_BYTES = 10 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;
export const FETCH_MAX_REDIRECTS = 3;

/** Content-Type przyjmowane z sieci (reszta → fetch_blocked). */
export const FETCH_ALLOWED_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/json',
]);

export type UrlPolicyResult = { ok: true; url: URL } | { ok: false; reason: string };

/** Walidacja składniowa URL: tylko http(s), porty 80/443, bez credentiali. */
export function validateFetchUrl(raw: string): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'nieprawidłowy URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `niedozwolony protokół ${url.protocol}` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'URL z danymi logowania jest odrzucany' };
  }
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    return { ok: false, reason: `niedozwolony port ${url.port} (tylko 80/443)` };
  }
  if (url.hostname === '') return { ok: false, reason: 'brak hosta' };
  return { ok: true, url };
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

const IPV4_PRIVATE_RANGES: [number, number][] = [
  [ipv4ToInt('0.0.0.0')!, 8], // "this network"
  [ipv4ToInt('10.0.0.0')!, 8], // RFC1918
  [ipv4ToInt('100.64.0.0')!, 10], // CGNAT
  [ipv4ToInt('127.0.0.0')!, 8], // loopback
  [ipv4ToInt('169.254.0.0')!, 16], // link-local (metadata endpoints!)
  [ipv4ToInt('172.16.0.0')!, 12], // RFC1918
  [ipv4ToInt('192.168.0.0')!, 16], // RFC1918
  [ipv4ToInt('192.0.0.0')!, 24], // IETF protocol assignments
  [ipv4ToInt('198.18.0.0')!, 15], // benchmarking
  [ipv4ToInt('224.0.0.0')!, 4], // multicast
  [ipv4ToInt('240.0.0.0')!, 4], // reserved + broadcast
];

function ipv4IsPrivate(ip: string): boolean | null {
  const n = ipv4ToInt(ip);
  if (n === null) return null;
  return IPV4_PRIVATE_RANGES.some(([base, prefix]) => n >>> (32 - prefix) === base >>> (32 - prefix));
}

/**
 * Czy adres IP jest publiczny (bezpieczny do fetchowania)? Odrzuca: loopback,
 * RFC1918, link-local (169.254 — metadata!), CGNAT, multicast, reserved;
 * IPv6: loopback, ULA fc00::/7, link-local fe80::/10, adresy IPv4-mapped
 * (klasyfikowane po zanurzonym IPv4). Nieparsowalne → false (fail-closed).
 */
export function isPublicAddress(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  if (trimmed === '') return false;
  if (!trimmed.includes(':')) {
    const priv = ipv4IsPrivate(trimmed);
    return priv === null ? false : !priv;
  }
  // IPv6
  const noZone = trimmed.split('%')[0]!;
  if (noZone === '::' || noZone === '::1') return false;
  // IPv4-mapped/translated: ::ffff:a.b.c.d albo ::ffff:0:a.b.c.d
  const v4m = /(?:^|:)(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(noZone);
  if (v4m) {
    const priv = ipv4IsPrivate(v4m[1]!);
    return priv === null ? false : !priv;
  }
  const firstGroup = noZone.split(':').find((g) => g !== '') ?? '';
  const first16 = parseInt(firstGroup.padEnd(4, '0'), 16);
  if (Number.isNaN(first16)) return false;
  if ((first16 & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((first16 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first16 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  return true;
}

/** Sprawdzenie listy adresów z DNS: WSZYSTKIE muszą być publiczne (anty-rebind częściowy). */
export function allAddressesPublic(ips: readonly string[]): boolean {
  return ips.length > 0 && ips.every((ip) => isPublicAddress(ip));
}

/** Normalizacja Content-Type (bez parametrów, lower-case) + decyzja allowlisty. */
export function contentTypeAllowed(header: string | null): { ok: boolean; type: string } {
  const type = (header ?? '').split(';')[0]!.trim().toLowerCase();
  return { ok: FETCH_ALLOWED_CONTENT_TYPES.has(type), type };
}
