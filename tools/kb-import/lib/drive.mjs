// Publiczny folder Google Drive bez API/klucza: listowanie przez widok osadzony
// (embeddedfolderview) i pobieranie przez uc?export=download z obsługą strony
// „nie można przeskanować antywirusem" (formularz z action → drive.usercontent.google.com).
// Czysta logika parsowania jest osobno (parseFolderListing, parseConfirmForm) — testy bez sieci.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname } from 'node:path';

const FOLDER_VIEW = (id) => `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}#list`;
const FILE_DOWNLOAD = (id) => `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;

/** Parsuje HTML widoku osadzonego → [{id, name, kind:'folder'|'file'}] w kolejności wyświetlania. */
export function parseFolderListing(html) {
  const entries = [];
  const re = /<div class="flip-entry"[^>]*id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const href = m[2];
    const name = decodeHtml(m[3]).trim();
    const kind = href.includes('/drive/folders/') ? 'folder' : 'file';
    entries.push({ id, name, kind });
  }
  return entries;
}

/** Strona „virus scan warning": zwraca URL pobrania z pól formularza albo null. */
export function parseConfirmForm(html) {
  const action = /<form[^>]+action="([^"]+)"/.exec(html)?.[1];
  if (!action) return null;
  const url = new URL(decodeHtml(action));
  const re = /<input type="hidden" name="([^"]+)" value="([^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) url.searchParams.set(m[1], decodeHtml(m[2]));
  return url.href;
}

export function decodeHtml(s) {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'");
}

/** Bezpieczna nazwa pliku na dysku (bez separatorów, bez ../, bez spacji). */
export function safeName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|\s]/g, '_').replace(/^\.+/, '').trim();
  return cleaned === '' ? 'bez-nazwy' : cleaned;
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return res.text();
}

/** Rekurencyjne listowanie: [{id, name, kind, path}] gdzie path = ścieżka względna z nazw folderów. */
export async function listFolderRecursive(folderId, prefix = '', depth = 0) {
  if (depth > 6) throw new Error('za głęboka struktura folderów (>6)');
  const html = await fetchText(FOLDER_VIEW(folderId));
  const entries = parseFolderListing(html);
  const out = [];
  for (const e of entries) {
    const path = prefix ? `${prefix}/${safeName(e.name)}` : safeName(e.name);
    if (e.kind === 'folder') {
      out.push(...(await listFolderRecursive(e.id, path, depth + 1)));
    } else {
      out.push({ ...e, path });
    }
  }
  return out;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Pobiera plik po id do `dest`; obsługuje stronę potwierdzenia. Zwraca {bytes, sha256}. */
export async function downloadFile(fileId, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  let res = await fetch(FILE_DOWNLOAD(fileId), { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} przy pobieraniu ${fileId}`);
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.startsWith('text/html')) {
    const html = await res.text();
    const confirmUrl = parseConfirmForm(html);
    if (!confirmUrl) throw new Error(`Drive zwrócił HTML bez formularza potwierdzenia dla ${fileId}`);
    res = await fetch(confirmUrl, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} przy potwierdzonym pobieraniu ${fileId}`);
    if ((res.headers.get('content-type') ?? '').startsWith('text/html')) {
      throw new Error(`Drive nadal zwraca HTML dla ${fileId} (limit pobrań albo plik niepubliczny)`);
    }
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return { bytes: statSync(dest).size, sha256: sha256File(dest) };
}

export function fileExistsWithSize(path) {
  return existsSync(path) && statSync(path).size > 0;
}
