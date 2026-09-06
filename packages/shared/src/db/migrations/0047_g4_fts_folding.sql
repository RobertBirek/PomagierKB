-- 0047 (G4/D8-04): indeks FTS5 na tekście ZŁOŻONYM (bez diakrytyków, 'ł'→'l').
--
-- Problem: chunks_fts używał tokenize='trigram' bez remove_diacritics, więc
-- zapytanie bez ogonków ('swiatla', 'przemyslowych' — typowe wejście agentów)
-- nie trafiało w treść z ogonkami. Sam 'remove_diacritics 1' nie wystarcza:
-- 'ł' (U+0142) nie dekomponuje się w NFD i tokenizer jej NIE składa
-- (zweryfikowane na SQLite 3.53.4 — 'przemyslow' nie trafiał 'przemysłowa').
--
-- Rozwiązanie: kolumny GENERATED ... VIRTUAL z 'ł'→'l' (zero kosztu składowania),
-- indeks FTS zewnętrzny po nich + tokenizer 'trigram remove_diacritics 1'
-- (składa pozostałe polskie znaki). 'rebuild' i 'integrity-check' działają,
-- bo kolumny są widoczne w tabeli treści.
--
-- Snippety NIE pochodzą już z snippet(chunks_fts,…) (dla trigramów licznik
-- znaczył trigramy, nie znaki → ~20-znakowe strzępy) — buduje je JS z
-- chunks_mirror.content, więc rozjazd kolumn indeksu z treścią jest nieszkodliwy.

ALTER TABLE chunks_mirror
  ADD COLUMN title_folded TEXT
  GENERATED ALWAYS AS (replace(replace(coalesce(title, ''), 'ł', 'l'), 'Ł', 'L')) VIRTUAL;

ALTER TABLE chunks_mirror
  ADD COLUMN content_folded TEXT
  GENERATED ALWAYS AS (replace(replace(content, 'ł', 'l'), 'Ł', 'L')) VIRTUAL;

DROP TRIGGER IF EXISTS chunks_ai;
DROP TRIGGER IF EXISTS chunks_ad;
DROP TRIGGER IF EXISTS chunks_au;
DROP TABLE IF EXISTS chunks_fts;

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title_folded, content_folded,
  content=chunks_mirror, content_rowid=rowid,
  tokenize='trigram remove_diacritics 1'
);

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks_mirror BEGIN
  INSERT INTO chunks_fts(rowid, title_folded, content_folded)
  VALUES (new.rowid,
          replace(replace(coalesce(new.title, ''), 'ł', 'l'), 'Ł', 'L'),
          replace(replace(new.content, 'ł', 'l'), 'Ł', 'L'));
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks_mirror BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title_folded, content_folded)
  VALUES ('delete', old.rowid,
          replace(replace(coalesce(old.title, ''), 'ł', 'l'), 'Ł', 'L'),
          replace(replace(old.content, 'ł', 'l'), 'Ł', 'L'));
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks_mirror BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title_folded, content_folded)
  VALUES ('delete', old.rowid,
          replace(replace(coalesce(old.title, ''), 'ł', 'l'), 'Ł', 'L'),
          replace(replace(old.content, 'ł', 'l'), 'Ł', 'L'));
  INSERT INTO chunks_fts(rowid, title_folded, content_folded)
  VALUES (new.rowid,
          replace(replace(coalesce(new.title, ''), 'ł', 'l'), 'Ł', 'L'),
          replace(replace(new.content, 'ł', 'l'), 'Ł', 'L'));
END;

-- Odbudowa indeksu z istniejącego mirrora (forward-only, bez utraty danych).
INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
