/**
 * Dialog z surowym kluczem API — sekret pokazywany DOKŁADNIE RAZ
 * (po utworzeniu lub rotacji). Alert warn + CodeBlock inline z kopiowaniem.
 */
import { t } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { Button } from '@/ui/button';
import { CodeBlock } from '@/ui/code-block';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';

export function RawKeyDialog({ raw, onClose }: { raw: string | null; onClose: () => void }) {
  return (
    <Dialog open={raw !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('mcp.raw.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Alert variant="warn">{t('mcp.raw.warning')}</Alert>
          {raw !== null && <CodeBlock inline code={raw} label={t('mcp.raw.keyLabel')} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            {t('mcp.raw.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
