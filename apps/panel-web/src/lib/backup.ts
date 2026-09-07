/**
 * Czysta logika strony /backup: mapowanie werdyktów na warianty kitu, formatowanie
 * rozmiarów i — najważniejsze — SKŁADANIE KOMEND ODTWARZANIA.
 *
 * Dlaczego komendy powstają w kodzie, a nie stoją w dokumencie jako tekst do przepisania:
 * runbook DR mylił się już raz co do nazw plików w snapshocie (`neo4j.tar.zst` zamiast
 * `neo4j-data.tar.zst`, `panel.sqlite3` zamiast `panel.sqlite`) i wyszło to dopiero
 * w audycie, bo nikt nie odtwarzał z runbooka na sucho. Komenda budowana z faktycznego
 * stempla snapshotu nie ma jak się rozjechać z rzeczywistością — a jeśli się rozjedzie,
 * rozjedzie się dla wszystkich naraz i widocznie.
 *
 * Zero importów Reacta i zero fetchy — testy w test/backup-lib.test.ts.
 */
import type { BackupVerdict } from '@/components/backup/types';

/** Werdykt → wariant Badge/Alert z kitu (ta sama skala co kokpit). */
export function verdictVariant(verdict: BackupVerdict): 'ok' | 'warn' | 'fail' | 'neutral' {
  switch (verdict) {
    case 'ok':
      return 'ok';
    case 'warn':
      return 'warn';
    case 'down':
      return 'fail';
    default:
      return 'neutral';
  }
}

/** Werdykt → ton kafelka metryki. */
export function verdictTone(verdict: BackupVerdict): 'ok' | 'warn' | 'fail' | 'default' {
  const variant = verdictVariant(verdict);
  return variant === 'neutral' ? 'default' : variant;
}

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/** Rozmiar po ludzku, po polsku (przecinek dziesiętny). `null` → '—'. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1).replace('.', ',')} ${UNITS[unit]}`;
}

/** Stempel snapshotu (`2026-09-07_142337`) → data czytelna po polsku. */
export function formatStamp(stamp: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (match === null) return stamp;
  const [, y, mo, d, h, mi] = match;
  return `${d}.${mo}.${y}, ${h}:${mi}`;
}

export interface RecoveryStep {
  /** Krótki tytuł kroku (już po polsku — składany tutaj, nie w słowniku: treść zależy od danych). */
  title: string;
  /** Dlaczego ten krok istnieje / na co uważać. Pusty = krok oczywisty. */
  note?: string;
  command: string;
}

export interface RecoveryContext {
  stamp: string | null;
  /** Nazwa artefaktu off-site, jeśli snapshot tam pojechał (`<stamp>.tar.age`). */
  offsiteArtifact: string | null;
  offsiteTarget: string | null;
  encryption: string | null;
}

/**
 * Procedura odtworzenia dla KONKRETNEGO snapshotu. Kolejność jest częścią kontraktu
 * z `docs/runbooks/disaster-recovery.md`: najpierw dowód integralności, potem dopiero
 * cokolwiek nadpisujemy. Odwrócenie tej kolejności to najdroższy możliwy błąd — restore
 * z uszkodzonego snapshotu niszczy stan bieżący i nie daje nic w zamian.
 */
export function recoverySteps(ctx: RecoveryContext): RecoveryStep[] {
  const stamp = ctx.stamp ?? '<STEMPEL>';
  const snap = `/srv/kag-data/backups/nightly/${stamp}`;
  const steps: RecoveryStep[] = [];

  if (ctx.offsiteArtifact !== null && ctx.offsiteTarget !== null) {
    const remote = ctx.offsiteTarget.startsWith('rclone://')
      ? ctx.offsiteTarget.slice('rclone://'.length)
      : ctx.offsiteTarget;
    steps.push({
      title: 'Ściągnij kopię off-site (gdy host jest stracony)',
      note: 'Pomiń, jeśli odtwarzasz na tym samym hoście i snapshot lokalny jest nienaruszony.',
      command: ctx.offsiteTarget.startsWith('rclone://')
        ? `RCLONE_CONFIG=/etc/kag/rclone.conf rclone copy "${remote}/${ctx.offsiteArtifact}" .`
        : `rsync -a "${remote}/${ctx.offsiteArtifact}" .`,
    });
    steps.push({
      title: 'Odszyfruj i rozpakuj',
      note:
        ctx.encryption === 'gpg'
          ? 'Klucz prywatny GPG jest POZA hostem. Bez niego archiwum jest bezużyteczne.'
          : 'Klucz prywatny age jest POZA hostem (sejf / menedżer haseł). Bez niego archiwum jest bezużyteczne — nie ma odzysku ani resetu.',
      command:
        ctx.encryption === 'gpg'
          ? `gpg --decrypt "${ctx.offsiteArtifact}" | tar -x`
          : `age -d -i <ścieżka/do/klucza.key> "${ctx.offsiteArtifact}" | tar -x`,
    });
  }

  steps.push({
    title: 'Sprawdź integralność ZANIM cokolwiek nadpiszesz',
    note: 'Każda niezgodna suma = ten snapshot jest do wyrzucenia. Weź starszy, nie „spróbuj mimo to”.',
    command: `cd "${snap}" && sha256sum -c SHA256SUMS`,
  });
  steps.push({
    title: 'Zobacz, co jest w środku',
    note: 'Manifest mówi, czy snapshot był kompletny (`ok`) i czy graf brano na gorąco czy na zimno.',
    command: `jq '{ok, neo4jMode, coreArtifacts, missingRequired, warnings}' "${snap}/_manifest.json"`,
  });
  steps.push({
    title: 'Odtwórz',
    note:
      'restore.sh zatrzymuje stacki, przywraca WSZYSTKIE magazyny z jednego snapshotu i startuje je z powrotem. ' +
      'Nadpisuje stan bieżący bezpowrotnie — uruchamiaj świadomie, na hoście, nie z panelu.',
    command: `sudo /kag/deploy/scripts/restore.sh --snapshot "${snap}"`,
  });
  steps.push({
    title: 'Udowodnij, że wyszło',
    note: 'Ta sama weryfikacja, która biega co tydzień — po odtworzeniu jest obowiązkowa, nie opcjonalna.',
    command: 'sudo /kag/deploy/scripts/verify_backup.sh && sudo /kag/deploy/scripts/smoke.sh',
  });
  return steps;
}

/**
 * Czy pokazać ostrzeżenie „klucz prywatny wciąż na hoście". Nie da się tego sprawdzić
 * z panelu (kontener nie widzi /root) — pytamy więc o to, co widać: skoro kopia jedzie
 * zaszyfrowana, ktoś MUSI mieć klucz prywatny poza hostem, bo inaczej szyfrowanie jest
 * teatrem. Przypomnienie kosztuje jedną linijkę, a jego brak kosztuje cały backup.
 */
export function shouldRemindAboutKeyCustody(encryption: string | null, offsiteStatus: string | null): boolean {
  return offsiteStatus === 'ok' && (encryption === 'age' || encryption === 'gpg');
}
