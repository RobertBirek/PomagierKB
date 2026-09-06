import type { Db } from '@pomagierkb/shared/db';
import { nowIso } from '@pomagierkb/shared/db';

/**
 * WERSJONOWANIE FLAGI dirty (audyt D7-04).
 *
 * Build trwa od sekund do dziesiątek minut, a promocja/withdraw szkicu nie jest
 * w tym czasie blokowana. Bezwarunkowe `clearDirty` po buildzie gubiło każdą taką
 * zmianę: rejestr twierdził „graf zsynchronizowany", choć eksport powstał ze
 * starszego snapshotu. Tu: migracja 0027 dodała `dirty_version` (podbijany
 * triggerem przy KAŻDYM markDirty) i `built_version`; build zapamiętuje wersję
 * w chwili eksportu i na końcu czyści flagę TYLKO gdy nic się nie zmieniło.
 */

export interface DirtySnapshot {
  namespace: string;
  version: number;
}

export function readDirtyVersion(db: Db, namespace: string): number {
  const row = db.prepare('SELECT dirty_version FROM kb_registry WHERE namespace = ?').get(namespace) as
    | { dirty_version: number }
    | undefined;
  return row?.dirty_version ?? 0;
}

/** Migawka wersji „stanu inboxu" do porównania po zakończeniu builda. */
export function snapshotDirty(db: Db, namespace: string): DirtySnapshot {
  return { namespace, version: readDirtyVersion(db, namespace) };
}

export interface DirtySettleResult {
  /** true = flaga wyczyszczona (graf zgodny ze snapshotem, nic nie doszło). */
  cleared: boolean;
  /** Liczba zmian inboxu, które weszły PO snapshocie (0 = build domknięty). */
  changedDuringBuild: number;
}

/**
 * Domknięcie builda: `built_version` = wersja snapshotu (co realnie jest w grafie),
 * a `dirty` zerowane tylko wtedy, gdy w trakcie builda nie było promocji/withdraw.
 * Inaczej flaga zostaje 1 — panel i quality gate uczciwie mówią „uruchom build".
 */
export function settleDirtyAfterBuild(db: Db, snapshot: DirtySnapshot): DirtySettleResult {
  const tx = db.transaction(() => {
    const current = readDirtyVersion(db, snapshot.namespace);
    const changed = Math.max(0, current - snapshot.version);
    if (changed === 0) {
      // UWAGA: `dirty = 0` nie odpala triggera podbijającego wersję (WHEN NEW.dirty = 1).
      db.prepare(
        'UPDATE kb_registry SET dirty = 0, built_version = ?, updated_at = ? WHERE namespace = ?',
      ).run(snapshot.version, nowIso(), snapshot.namespace);
      return { cleared: true, changedDuringBuild: 0 };
    }
    db.prepare('UPDATE kb_registry SET built_version = ?, updated_at = ? WHERE namespace = ?').run(
      snapshot.version,
      nowIso(),
      snapshot.namespace,
    );
    return { cleared: false, changedDuringBuild: changed };
  });
  return tx.immediate();
}
