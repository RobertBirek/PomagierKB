/**
 * Minimalny parser multipart/form-data (bez zależności) — wystarczający dla
 * uploadu jednego pliku CSV w stubie. Nie obsługuje zagnieżdżonych multipartów
 * ani kodowań transferu — dev only.
 */

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export function parseMultipart(body: Buffer, contentTypeHeader: string): MultipartPart[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader);
  const boundary = (m?.[1] ?? m?.[2])?.trim();
  if (!boundary) return [];

  const delim = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const afterDelim = pos + delim.length;
    // '--' zaraz po delimiterze = terminator całego multiparta
    if (body.subarray(afterDelim, afterDelim + 2).toString('latin1') === '--') break;
    const next = body.indexOf(delim, afterDelim);
    if (next === -1) break;

    // część między delimiterami: \r\n<nagłówki>\r\n\r\n<dane>\r\n
    const chunk = body.subarray(afterDelim + 2, next - 2);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      pos = next;
      continue;
    }
    const rawHeaders = chunk.subarray(0, headerEnd).toString('utf8');
    const data = chunk.subarray(headerEnd + 4);
    const disp = /content-disposition:[^\r\n]*?name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(rawHeaders);
    const ct = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders);

    const part: MultipartPart = { name: disp?.[1] ?? '', data: Buffer.from(data) };
    if (disp?.[2] !== undefined) part.filename = disp[2];
    if (ct?.[1] !== undefined) part.contentType = ct[1].trim();
    parts.push(part);
    pos = next;
  }
  return parts;
}
