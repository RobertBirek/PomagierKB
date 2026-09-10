#!/usr/bin/env node
// Wysyła fragmenty .md z katalogu (manifest.json z prepare*.mjs) przez POST /api/v1/content
// (JSON {text,title,sourceUrl}), śledzi intake do drafted|failed, zapisuje state.json (wznawialne).
// Użycie: node tools/kb-import/upload.mjs --dir <out/docs> [--only <regex pliku>] [--limit N] [--concurrency 2]
//         [--no-wait]  (bez czekania na drafty — tylko wysyłka)
// Limity serwera: 60 mutacji/min (throttle 50), intake równolegle 2, 10 min/dokument.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PanelClient, expectOk } from './lib/client.mjs';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const dir = opt('--dir');
const only = opt('--only');
const limit = Number(opt('--limit', '100000'));
const wait = !args.includes('--no-wait');
if (!dir) {
  console.error('użycie: upload.mjs --dir <katalog z manifest.json> [--only regex] [--limit N] [--no-wait]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const statePath = join(dir, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { items: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const TITLE_MAX = 300;
const client = await new PanelClient().open();
console.log(`zalogowano jako ${client.user}`);
let sent = 0;
let skipped = 0;
let failed = 0;
try {
  const todo = manifest.entries.filter((e) => !only || new RegExp(only).test(e.file)).slice(0, limit);
  for (const e of todo) {
    const st = state.items[e.file] ?? {};
    const text = readFileSync(join(dir, e.file), 'utf8');
    const sha = createHash('sha256').update(text).digest('hex');
    // Fragment już wysłany i NIEZMIENIONY → pomijamy; zmieniona treść (nowy sha) idzie ponownie
    // pod tym samym sourceUrl i zastępuje starą wersję przy buildzie (precedencja source_ref).
    if ((st.draftId || st.status === 'drafted') && st.sha === sha) {
      skipped += 1;
      continue;
    }
    if (text.length > 100_000) {
      state.items[e.file] = { status: 'too_large', chars: text.length };
      failed += 1;
      save();
      console.error(`! ${e.file}: ${text.length} znaków > 100000`);
      continue;
    }
    const title = e.title.length > TITLE_MAX ? e.title.slice(0, TITLE_MAX - 1) + '…' : e.title;
    const res = await client.post('/api/v1/content', { text, title, sourceUrl: e.sourceUrl }, { 'idempotency-key': `kb-import:${sha.slice(0, 24)}` });
    let data;
    try {
      data = expectOk(res, `POST /content ${e.file}`);
    } catch (err) {
      failed += 1;
      state.items[e.file] = { status: 'post_failed', error: String(err.message).slice(0, 300) };
      save();
      console.error(`! ${err.message}`);
      continue;
    }
    const intakeId = data.intakeId ?? data.intake?.id ?? data.id;
    state.items[e.file] = { intakeId, status: data.status ?? data.intake?.status ?? 'received', draftId: data.draftId ?? null, sentAt: new Date().toISOString(), sourceUrl: e.sourceUrl, title, sha };
    save();
    sent += 1;
    console.log(`+ ${e.file} → ${intakeId}${data.deduplicated ? ' (dedup)' : ''}`);
  }
  console.log(`wysłano ${sent}, pominięto ${skipped}, błędy ${failed}`);

  if (wait) {
    // Polling intake'ów do stanu terminalnego; retry dla failed (≤3 prób, tylko przy błędach tymczasowych).
    const pending = () => Object.entries(state.items).filter(([, s]) => s.intakeId && !s.draftId && !['failed_final', 'too_large', 'post_failed'].includes(s.status));
    let idle = 0;
    while (pending().length > 0 && idle < 200) {
      let progressed = false;
      for (const [file, s] of pending()) {
        const r = await client.get(`/api/v1/content/${s.intakeId}`);
        if (r.status !== 200) continue;
        const d = r.body.data?.intake ?? r.body.data;
        const status = d.status;
        if (status !== s.status) progressed = true;
        s.status = status;
        s.lastError = d.error ? `${d.error}: ${d.errorDetail ?? ''}` : null;
        if (status === 'drafted') {
          s.draftId = d.draftId ?? d.draft_id ?? null;
          console.log(`✓ ${file} → draft ${s.draftId}`);
        } else if (status === 'failed') {
          s.attempts = (s.attempts ?? 0) + 1;
          const errText = JSON.stringify(s.lastError ?? '');
          if (s.attempts <= 3 && /rate_limited|timeout|busy|temporar|llm|503|502|429/i.test(errText)) {
            const rr = await client.post(`/api/v1/content/${s.intakeId}/retry`, {});
            console.log(`↻ ${file}: retry ${s.attempts} (${rr.status}) po ${errText.slice(0, 120)}`);
            s.status = 'received';
          } else {
            s.status = 'failed_final';
            console.error(`✗ ${file}: ${errText.slice(0, 300)}`);
          }
        }
      }
      save();
      idle = progressed ? 0 : idle + 1;
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
} finally {
  save();
  await client.close();
}
const done = Object.values(state.items).filter((s) => s.draftId).length;
const bad = Object.values(state.items).filter((s) => ['failed_final', 'too_large', 'post_failed'].includes(s.status)).length;
console.log(`stan: drafty ${done}, nieudane ${bad}, w toku ${Object.values(state.items).length - done - bad}`);
