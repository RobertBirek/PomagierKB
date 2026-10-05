#!/usr/bin/env node
// tika-extract-check.mjs — wysyła pliki testowe do wskazanej Tiki i sprawdza, czy po
// obróbce pipeline'u (stripXhtml / normalizeTikaMarkdown) zostają oczekiwane frazy.
// Wymaga zbudowanego panel-api (apps/panel-api/dist). Pliki: tools/eval/fixtures/tika
// (treść syntetyczna). Użycie:
//   node tools/eval/tika-extract-check.mjs --url http://<ip-kontenera>:9998
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripXhtml, normalizeTikaMarkdown } from '../../apps/panel-api/dist/pipeline/extract.js';

const i = process.argv.indexOf('--url');
const url = i >= 0 ? process.argv[i + 1] : null;
if (!url) {
  console.error('użycie: tika-extract-check.mjs --url http://host:9998');
  process.exit(2);
}
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tika');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const CASES = [
  { file: 'sample.docx', mime: DOCX, must: ['Procedura zwrotu towaru', 'dok_Status', 'dok__Dokument', '<strefa zwrotów>', 'zrealizowane'] },
  { file: 'sample.html', mime: 'text/html', must: ['Montaż żyrandola', 'Zażółć gęślą jaźń', 'E27'] },
  { file: 'skan.png', mime: 'image/png', must: ['PROTOKÓŁ REKLAMACJI', 'sześcioramienny', 'zgłoszenie nr 4471'], ocr: true },
  { file: 'skan.pdf', mime: 'application/pdf', must: ['PROTOKÓŁ REKLAMACJI', 'Żyrandol', '1 249,00 zł'], ocr: true },
];
let failed = 0;
for (const c of CASES) {
  const t0 = Date.now();
  let status = 0;
  let type = '';
  let text = '';
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/tika`, {
      method: 'PUT',
      headers: { 'content-type': c.mime },
      body: readFileSync(join(dir, c.file)),
    });
    status = res.status;
    type = (res.headers.get('content-type') ?? '').toLowerCase();
    const body = await res.text();
    text = /xml|html/.test(type) || /^\s*<(\?xml|!doctype|html)\b/i.test(body) ? stripXhtml(body) : normalizeTikaMarkdown(body);
  } catch (err) {
    type = `błąd: ${err instanceof Error ? err.message : String(err)}`;
  }
  const missing = c.must.filter((m) => !text.includes(m));
  const ok = status === 200 && missing.length === 0;
  if (!ok) failed++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${c.file.padEnd(12)} HTTP ${status} ${type.padEnd(26)} ${String(text.length).padStart(5)} zn ${String(Date.now() - t0).padStart(5)} ms` +
      `${c.ocr ? ' (OCR)' : ''}${missing.length ? '  brak: ' + missing.join(' | ') : ''}`,
  );
}
process.exit(failed === 0 ? 0 : 1);
