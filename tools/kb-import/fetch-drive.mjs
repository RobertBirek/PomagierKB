#!/usr/bin/env node
// Pobiera publiczny folder Google Drive (rekurencyjnie) do katalogu raw/ i zapisuje manifest.
// Użycie: node tools/kb-import/fetch-drive.mjs <folderId> --out <katalog> [--exclude <regex>]
// --exclude pomija ścieżki (np. rozpakowane kopie CHM: ^Pomoc/(gta|infogt|insertgt)/).
// Wznawialne: plik o tej samej nazwie i sha256 w manifeście jest pomijany.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadFile, fileExistsWithSize, listFolderRecursive, sha256File } from './lib/drive.mjs';

const args = process.argv.slice(2);
const folderId = args.find((a) => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
const exIdx = args.indexOf('--exclude');
const exclude = exIdx >= 0 ? new RegExp(args[exIdx + 1]) : null;
if (!folderId || !outDir) {
  console.error('użycie: fetch-drive.mjs <folderId> --out <katalog> [--exclude <regex ścieżki>]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const manifestPath = join(outDir, 'manifest.json');
let manifest = { folderId, files: {} };
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  /* pierwszy bieg */
}

const all = await listFolderRecursive(folderId);
const entries = exclude ? all.filter((e) => !exclude.test(e.path)) : all;
console.log(`plików w folderze: ${all.length}, po wykluczeniach: ${entries.length}`);
let done = 0;
let failed = 0;
for (const e of entries) {
  const dest = join(outDir, e.path);
  const known = manifest.files[e.id];
  if (known && fileExistsWithSize(dest) && sha256File(dest) === known.sha256) {
    console.log(`= ${e.path} (bez zmian)`);
    done += 1;
    continue;
  }
  try {
    const { bytes, sha256 } = await downloadFile(e.id, dest);
    manifest.files[e.id] = {
      id: e.id,
      name: e.name,
      path: e.path,
      bytes,
      sha256,
      fetchedAt: new Date().toISOString(),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`+ ${e.path} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    done += 1;
  } catch (err) {
    failed += 1;
    console.error(`! ${e.path}: ${err.message}`);
  }
}
console.log(`gotowe: ${done}, błędy: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
