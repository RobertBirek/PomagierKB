/**
 * Upload multipart z paskiem postępu przez XMLHttpRequest — fetch nie
 * raportuje postępu wysyłki, a lib/api.ts jest NIETYKALNY (helper lokalny
 * strony /add, zgodnie z planem). Kontrakt odpowiedzi identyczny z apiFetch:
 * koperta {ok:true,data}/{ok:false,error:{code,message,details}} → ApiError.
 */
import { ApiError } from '../../lib/api';

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
}

/**
 * POST FormData na path (cookie sesji jak w apiFetch: withCredentials).
 * onProgress dostaje ułamek 0..1 postępu WYSYŁKI (upload, nie download).
 */
export function uploadWithProgress<T>(
  path: string,
  form: FormData,
  onProgress: (fraction: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.responseType = 'text';

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) onProgress(ev.loaded / ev.total);
    };
    xhr.onerror = () => reject(new ApiError('network_error', 'Brak połączenia z serwerem', 0));
    xhr.ontimeout = () => reject(new ApiError('network_error', 'Przekroczono czas żądania', 0));
    xhr.onabort = () => reject(new ApiError('aborted', 'Wysyłka przerwana', 0));

    xhr.onload = () => {
      let body: Envelope<T> | null = null;
      try {
        body = JSON.parse(xhr.responseText) as Envelope<T>;
      } catch {
        body = null;
      }
      if (body === null || body.ok !== true) {
        const err = body?.error;
        reject(
          new ApiError(
            err?.code ?? (xhr.status >= 200 && xhr.status < 300 ? 'invalid_response' : `http_${xhr.status}`),
            err?.message ?? `Błąd serwera (HTTP ${xhr.status})`,
            xhr.status,
            err?.details,
          ),
        );
        return;
      }
      resolve(body.data as T);
    };

    xhr.send(form);
  });
}
