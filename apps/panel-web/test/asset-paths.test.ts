/**
 * Test regresyjny D13-01: panel jest serwowany z korzenia domeny przez fallback
 * SPA panel-api, więc WSZYSTKIE odwołania do zasobów muszą być bezwzględne.
 * Przy ścieżkach relatywnych (base:'./') wejście na trasę z końcowym ukośnikiem
 * (/inbox/) kazało przeglądarce pobrać /inbox/assets/index-*.js — fallback
 * oddawał index.html (200 text/html), moduł padał na kontroli MIME i użytkownik
 * dostawał białą stronę bez komunikatu.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('ścieżki zasobów panelu (D13-01)', () => {
  it("vite.config.ts ma base:'/' (nie relatywne './')", () => {
    const config = read('../vite.config.ts');
    expect(config).toMatch(/base:\s*'\/'/);
    expect(config).not.toMatch(/base:\s*'\.\/'/);
  });

  it('index.html nie odwołuje się relatywnie do żadnego zasobu', () => {
    const html = read('../index.html');
    const relative = [...html.matchAll(/(?:href|src)="(\.\/[^"]*)"/g)].map((m) => m[1]);
    expect(relative, `relatywne odwołania w index.html: ${relative.join(', ')}`).toEqual([]);
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('href="/icon.svg"');
  });

  it('manifest PWA ma bezwzględne start_url/scope/ikony', () => {
    const manifest = JSON.parse(read('../public/manifest.webmanifest')) as {
      start_url: string;
      scope: string;
      icons: { src: string }[];
    };
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    for (const icon of manifest.icons) expect(icon.src.startsWith('/')).toBe(true);
  });
});
