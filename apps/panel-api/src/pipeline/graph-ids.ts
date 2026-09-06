import type { Db } from '@pomagierkb/shared/db';
import { nowIso } from '@pomagierkb/shared/db';

/**
 * REJESTR ID W GRAFIE + PROPAGACJA USUNIĘĆ (audyt D14-01/D7-02/D14-02).
 *
 * Builder OpenSPG ma tylko UPSERT — nie ma operacji kasującej, na którą można
 * bezpiecznie liczyć (endpointy DELETE nie są zweryfikowane w boju). Dlatego
 * stan „co realnie wysłaliśmy do grafu" trzymamy w tabeli `graph_ids`, a różnicę
 * (poprzedni eksport ∖ bieżący) domykamy NAGROBKAMI: wierszem UPSERT o tym samym
 * id, który nadpisuje treść i wektory neutralnym markerem i oznacza encję jako
 * `semanticType='tombstone'`. Po nadpisaniu wycofana treść nie istnieje już
 * w Neo4j ani w indeksie wektorowym — nie da się jej wydobyć ani przez
 * search/text, ani przez query/spgType.
 *
 * Nagrobek jest POTWIERDZANY dopiero po udanym buildzie (confirmTombstones):
 * jeśli build padnie, kolejny eksport wystawi go ponownie.
 */

export type GraphEntity = 'Topic' | 'ReferenceDocument' | 'Chunk';

export interface GraphIdRef {
  id: string;
  entity: GraphEntity;
}

/**
 * Markery nagrobka mieszkają w `@pomagierkb/shared/openspg` — czytają je także narzędzia MCP,
 * które nie mogą zależeć od panel-api. Re-eksport, żeby nie zmieniać importów w pipelinie.
 */
export { TOMBSTONE_CONTENT, TOMBSTONE_SEMANTIC_TYPE } from '@pomagierkb/shared/openspg';

interface GraphIdRow {
  id: string;
  entity: string;
}

function toRefs(rows: GraphIdRow[]): GraphIdRef[] {
  return rows.map((r) => ({ id: r.id, entity: r.entity as GraphEntity }));
}

/**
 * Zapisuje bieżący stan docelowy i zwraca id, które WYPADŁY ze stanu docelowego,
 * a nie mają jeszcze potwierdzonego nagrobka (do wystawienia w tym eksporcie).
 * Całość w jednej transakcji — eksport jest jedynym pisarzem tej tabeli.
 */
export function syncGraphIds(
  db: Db,
  namespace: string,
  runId: number,
  current: readonly GraphIdRef[],
): GraphIdRef[] {
  const now = nowIso();
  const upsert = db.prepare(
    `INSERT INTO graph_ids (namespace, id, entity, live, last_seen_run, tombstone_run_id,
       tombstoned_at, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 1, ?, NULL, NULL, ?, ?)
     ON CONFLICT(namespace, id) DO UPDATE SET
       entity = excluded.entity, live = 1, last_seen_run = excluded.last_seen_run,
       tombstone_run_id = NULL, tombstoned_at = NULL, last_seen_at = excluded.last_seen_at`,
  );
  const tx = db.transaction(() => {
    for (const ref of current) upsert.run(namespace, ref.id, ref.entity, runId, now, now);
    // Wypadły ze stanu docelowego (withdraw, sprostowanie, zmiana tożsamości dokumentu).
    db.prepare(
      `UPDATE graph_ids SET live = 0, tombstone_run_id = ?, tombstoned_at = NULL
       WHERE namespace = ? AND live = 1 AND (last_seen_run IS NULL OR last_seen_run <> ?)`,
    ).run(runId, namespace, runId);
    // Zaległe nagrobki (także z runów, które padły po eksporcie) idą w tym eksporcie.
    db.prepare(
      'UPDATE graph_ids SET tombstone_run_id = ? WHERE namespace = ? AND live = 0 AND tombstoned_at IS NULL',
    ).run(runId, namespace);
    return db
      .prepare(
        `SELECT id, entity FROM graph_ids
         WHERE namespace = ? AND live = 0 AND tombstoned_at IS NULL ORDER BY entity, id`,
      )
      .all(namespace) as GraphIdRow[];
  });
  return toRefs(tx.immediate());
}

/** Po udanym buildzie: nagrobki z tego runu są potwierdzone (są już w grafie). */
export function confirmTombstones(db: Db, namespace: string, runId: number): number {
  const res = db
    .prepare(
      `UPDATE graph_ids SET tombstoned_at = ?
       WHERE namespace = ? AND tombstone_run_id = ? AND live = 0 AND tombstoned_at IS NULL`,
    )
    .run(nowIso(), namespace, runId);
  return res.changes;
}

/** Nagrobki niepotwierdzone (graf ma treść, której nie ma w stanie docelowym). */
export function pendingTombstones(db: Db, namespace: string): GraphIdRef[] {
  return toRefs(
    db
      .prepare(
        `SELECT id, entity FROM graph_ids
         WHERE namespace = ? AND live = 0 AND tombstoned_at IS NULL ORDER BY entity, id`,
      )
      .all(namespace) as GraphIdRow[],
  );
}

/**
 * Nagrobki POTWIERDZONE — rejestr uważa je za wystawione i zaakceptowane przez build.
 *
 * „Potwierdzone" znaczy tylko tyle, że job buildera zakończył się sukcesem. Przebudowa
 * produkcji 2026-09-06 pokazała, że to za mało: builder OpenSPG przyjął wiersze-nagrobki,
 * zwrócił sukces i NIE nadpisał węzłów — zostały z pełną treścią. Dlatego bramka jakości
 * bierze tę listę i pyta o nią GRAF, zamiast wierzyć rejestrowi na słowo.
 */
export function confirmedTombstones(db: Db, namespace: string, limit = 20): GraphIdRef[] {
  return toRefs(
    db
      .prepare(
        `SELECT id, entity FROM graph_ids
         WHERE namespace = ? AND live = 0 AND tombstoned_at IS NOT NULL
         ORDER BY tombstoned_at DESC, id LIMIT ?`,
      )
      .all(namespace, limit) as GraphIdRow[],
  );
}

/** Id żywe w grafie wg rejestru (diagnostyka i testy). */
export function liveGraphIds(db: Db, namespace: string): GraphIdRef[] {
  return toRefs(
    db
      .prepare('SELECT id, entity FROM graph_ids WHERE namespace = ? AND live = 1 ORDER BY entity, id')
      .all(namespace) as GraphIdRow[],
  );
}
