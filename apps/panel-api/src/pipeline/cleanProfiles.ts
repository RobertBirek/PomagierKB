/**
 * Etap 3 pipeline'u — PROFILE CZYSZCZENIA (dane jako stałe, zero logiki).
 * Wzorce PL wzorowane na optimaKB: inlinePatterns wycinane ze środka linii
 * (REKLAMA, newsletter, cookies, udostępnij, czytaj także...), dropLinePatterns
 * usuwają CAŁE linie (menu, stopki, ©, numery stron, paginacja).
 * Logika (cleanContent) w clean.ts — ten plik to wyłącznie dane.
 */

export type CleanProfileName = 'news' | 'blog' | 'docs' | 'pdf' | 'generic';

export interface CleanProfile {
  name: CleanProfileName;
  /** Frazy boilerplate wycinane ze środka linii (flaga g wymagana). */
  inlinePatterns: readonly RegExp[];
  /** Linia dopasowana w całości → usunięta. */
  dropLinePatterns: readonly RegExp[];
}

/** Wspólny rdzeń wszystkich profili — typowy boilerplate stron/dokumentów PL. */
const BASE_INLINE: readonly RegExp[] = [
  /\bREKLAMA\b/g,
  /\bartykuł sponsorowany\b/gi,
  /zapisz się (do|na) newslettera?/gi,
  /\bnewsletter\b:?/gi,
  /(akceptuj[ęe]?|polityka|ustawienia|zgoda na)\s+(pliki\s+)?cookies?/gi,
  /ta strona (używa|wykorzystuje) (plików\s+)?cookies?/gi,
  /udost[ęe]pnij(\s+(na|przez)\s+\S+)?:?/gi,
  /podziel się:?/gi,
  /czytaj (także|też|więcej|dalej):?/gi,
  /zobacz (również|też|także):?/gi,
  /przeczytaj (również|też|także):?/gi,
  /kliknij,? aby powiększyć/gi,
  /obserwuj nas (na|w) \S+/gi,
];

const BASE_DROP: readonly RegExp[] = [
  /^\d+$/, // goły numer strony
  /^[-–—•|.\s]*$/, // linia z samych separatorów/pustki
  /^(strona|str\.?)\s+\d+(\s*(z|\/)\s*\d+)?$/i, // "Strona 3 z 12"
  /^page\s+\d+(\s+of\s+\d+)?$/i,
  /^©.*$/,
  /^copyright\b.*$/i,
  /^wszelkie prawa zastrzeżone.*$/i,
  /^(menu|nawigacja|szukaj|wyszukaj|zaloguj( się)?|zarejestruj( się)?)$/i,
  /^(strona główna|kontakt|o nas|o firmie|mapa strony|do góry|wstecz|dalej)$/i,
  /^(polityka prywatności|regulamin|polityka cookies|rodo)$/i,
  /^(facebook|twitter|x|instagram|linkedin|youtube|tiktok)$/i,
  /^tagi?:.*$/i,
  /^kategorie?:.*$/i,
  /^udostępnij.*$/i,
  /^skomentuj$/i,
];

/** Boilerplate portali informacyjnych. */
const NEWS_DROP: readonly RegExp[] = [
  /^(źródło|zdjęcie|fot\.?|foto):.*$/i,
  /^materiał (partnera|promocyjny|sponsorowany).*$/i,
  /^\d+\s+komentarz(e|y)?$/i,
  /^dodaj komentarz$/i,
  /^najnowsze( artykuły| wiadomości)?$/i,
  /^(polecane|popularne|powiązane)( artykuły| wpisy| tematy)?$/i,
];

/** Boilerplate blogów. */
const BLOG_DROP: readonly RegExp[] = [
  /^(autor|opublikowano|data publikacji):.*$/i,
  /^\d+\s+komentarz(e|y)?$/i,
  /^dodaj komentarz$/i,
  /^(poprzedni|następny) wpis.*$/i,
  /^(podobne|powiązane) wpisy$/i,
  /^subskrybuj.*$/i,
];

/** Boilerplate stron dokumentacji. */
const DOCS_DROP: readonly RegExp[] = [
  /^spis treści$/i,
  /^na tej stronie$/i,
  /^(edytuj|popraw) tę stronę.*$/i,
  /^ostatnia aktualizacja:.*$/i,
  /^wersja:?\s*[\d.]+$/i,
];

/** Boilerplate PDF-ów (nagłówki/stopki powtarzane per strona, paginacja). */
const PDF_DROP: readonly RegExp[] = [
  /^[-–—\s]*\d+\s*[-–—\s]*$/, // "- 3 -"
  /^\d+\s*\|\s*(strona|page)$/i, // "3 | Strona"
  /^(strona|page)\s*\|\s*\d+$/i,
];

export const CLEAN_PROFILES: Record<CleanProfileName, CleanProfile> = {
  generic: {
    name: 'generic',
    inlinePatterns: BASE_INLINE,
    dropLinePatterns: BASE_DROP,
  },
  news: {
    name: 'news',
    inlinePatterns: BASE_INLINE,
    dropLinePatterns: [...BASE_DROP, ...NEWS_DROP],
  },
  blog: {
    name: 'blog',
    inlinePatterns: BASE_INLINE,
    dropLinePatterns: [...BASE_DROP, ...BLOG_DROP],
  },
  docs: {
    name: 'docs',
    inlinePatterns: BASE_INLINE,
    dropLinePatterns: [...BASE_DROP, ...DOCS_DROP],
  },
  pdf: {
    name: 'pdf',
    inlinePatterns: BASE_INLINE,
    dropLinePatterns: [...BASE_DROP, ...PDF_DROP],
  },
};

/**
 * Heurystyka wyboru profilu po mime/URL (nadpisywalna w UI).
 * pdf → 'pdf'; URL z /blog → 'blog'; docs/wiki → 'docs'; inny http(s) → 'news';
 * reszta → 'generic'.
 */
export function pickProfile(opts: { mime?: string | null; sourceUrl?: string | null }): CleanProfileName {
  if (opts.mime === 'application/pdf') return 'pdf';
  const url = (opts.sourceUrl ?? '').toLowerCase();
  if (url.startsWith('http')) {
    if (url.includes('blog')) return 'blog';
    if (url.includes('docs') || url.includes('wiki') || url.includes('dokumentacja')) return 'docs';
    return 'news';
  }
  return 'generic';
}
