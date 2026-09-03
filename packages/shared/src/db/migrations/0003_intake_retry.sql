-- 0003_intake_retry.sql — odporność pipeline'u: ponawianie nieudanych intake'ów
-- (attempts z limitem w workerze) i sprawiedliwa kolejność przetwarzania
-- (size_bytes: małe/tekstowe przed 50-megabajtowym OCR-em).

ALTER TABLE intakes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intakes ADD COLUMN size_bytes INTEGER;
