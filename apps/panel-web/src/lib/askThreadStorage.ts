/**
 * Adapter sessionStorage dla wątku /ask. CAŁA logika kształtu jest w askThread.ts
 * (czysta, testowana) — tutaj zostaje wyłącznie dostęp do DOM w try/catch.
 *
 * Wątek zawiera treść bazy wiedzy (pytania, pełne odpowiedzi LLM, snippety
 * źródeł), a sessionStorage przeżywa wylogowanie: jest przypisany do KARTY,
 * więc wyjście na endpoint wylogowania Authentika i powrót na panel w tej samej
 * karcie go zachowuje. Dlatego wątek jest związany z tożsamością (owner) i
 * kasowany jawnie przy wylogowaniu — patrz components/shell/Topbar.tsx.
 */
import {
  ASK_THREAD_STORAGE_KEY,
  deserializeThread,
  serializeThread,
  type ThreadEntry,
} from './askThread';

/** Wątek zapisany przez TEGO użytkownika; obcy albo bez właściciela → []. */
export function readThread(owner: string | null): ThreadEntry[] {
  try {
    return deserializeThread(sessionStorage.getItem(ASK_THREAD_STORAGE_KEY), owner);
  } catch {
    return [];
  }
}

/** Zapis wątku właściciela. Bez znanej tożsamości NIC nie utrwalamy. */
export function writeThread(entries: readonly ThreadEntry[], owner: string | null): void {
  try {
    if (owner === null || owner === '') {
      sessionStorage.removeItem(ASK_THREAD_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(ASK_THREAD_STORAGE_KEY, serializeThread(entries, owner));
  } catch {
    /* prywatny tryb / brak storage — wątek działa bez trwałości */
  }
}

/** Usunięcie wątku z karty (wylogowanie, zmiana tożsamości). */
export function clearThread(): void {
  try {
    sessionStorage.removeItem(ASK_THREAD_STORAGE_KEY);
  } catch {
    /* brak storage — nie ma czego czyścić */
  }
}
