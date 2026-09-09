import sql from 'mssql';
import { describeTarget, loadMssqlConfig } from './env.mjs';

/** Otwiera pulę; błędy połączenia raportuje bez hasła. */
export async function openPool(overrides = {}) {
  const cfg = { ...loadMssqlConfig(), ...overrides };
  try {
    const pool = await new sql.ConnectionPool(cfg).connect();
    return { pool, target: describeTarget(cfg) };
  } catch (err) {
    throw new Error(`połączenie z MSSQL ${describeTarget(cfg)} nieudane: ${err.message}`);
  }
}

export async function query(pool, text) {
  const res = await pool.request().query(text);
  return res.recordset ?? [];
}
