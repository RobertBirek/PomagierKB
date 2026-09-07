import { describe, expect, it } from 'vitest';
import {
  applyPiiPolicy,
  coercePiiPolicy,
  detectPii,
  isValidIban,
  isValidIdCard,
  isValidNip,
  isValidPesel,
  isValidRegon,
  summarize,
} from '../src/pii/index.js';

/**
 * Testy negatywne są tu ważniejsze od pozytywnych. Detektor, który krzyczy na kody
 * katalogowe opraw oświetleniowych i daty obowiązywania procedur, zostanie wyłączony
 * po tygodniu — i wtedy nie ochroni przed niczym. Dlatego połowa tego pliku pilnuje,
 * czego wykrywać NIE WOLNO.
 */

// Numery wygenerowane pod sumy kontrolne wyłącznie na potrzeby testu — nie są niczyje.
const PESEL_OK = '44051401359';
const NIP_OK = '5252248481';
const IBAN_OK = 'PL61109010140000071219812874';

describe('sumy kontrolne', () => {
  it('PESEL: poprawny przechodzi, przekręcona cyfra nie', () => {
    expect(isValidPesel(PESEL_OK)).toBe(true);
    expect(isValidPesel('44051401358')).toBe(false);
  });

  it('PESEL: sama suma nie wystarcza — data musi mieć sens', () => {
    // 11 cyfr zgodnych z sumą, ale miesiąc 99 nie istnieje w żadnym stuleciu.
    const digits = [1, 2, 9, 9, 1, 5, 1, 2, 3, 4];
    const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
    const sum = digits.reduce((acc, d, i) => acc + d * weights[i]!, 0);
    const candidate = digits.join('') + String((10 - (sum % 10)) % 10);
    expect(candidate).toHaveLength(11);
    expect(isValidPesel(candidate)).toBe(false);
  });

  it('NIP: poprawny przechodzi; reszta 10 jest odrzucana', () => {
    expect(isValidNip(NIP_OK)).toBe(true);
    expect(isValidNip('1234567890')).toBe(false);
  });

  it('REGON: 9 i 14 cyfr', () => {
    expect(isValidRegon('123456785')).toBe(true);
    expect(isValidRegon('123456789')).toBe(false);
    expect(isValidRegon('12345678512347')).toBe(true);
  });

  it('IBAN: mod 97', () => {
    expect(isValidIban(IBAN_OK)).toBe(true);
    expect(isValidIban('PL61109010140000071219812875')).toBe(false);
    expect(isValidIban('PL 61 1090 1014 0000 0712 1981 2874')).toBe(true);
  });

  it('dowód osobisty: cyfra kontrolna na czwartej pozycji', () => {
    expect(isValidIdCard('ABA300000')).toBe(true);
    expect(isValidIdCard('ABA300001')).toBe(false);
  });
});

describe('detectPii — trafienia', () => {
  it('znajduje PESEL, NIP, IBAN i e-mail w zdaniu', () => {
    const text = `Pracownik ${PESEL_OK}, firma NIP ${NIP_OK}, rachunek ${IBAN_OK}, kontakt jan@example.com.`;
    const report = summarize(detectPii(text));
    expect(report.types).toEqual(['email', 'iban', 'nip', 'pesel']);
    expect(report.total).toBe(4);
  });

  it('telefon i data urodzenia TYLKO w kontekście', () => {
    const withContext = summarize(detectPii('tel. 601 234 567, ur. 1985-04-12'));
    expect(withContext.types).toEqual(['birth_date', 'phone']);

    const withoutContext = summarize(detectPii('Kod 601234567, obowiązuje od 1985-04-12'));
    expect(withoutContext.total).toBe(0);
  });

  it('REGON i numer dowodu też wymagają kontekstu', () => {
    expect(summarize(detectPii('REGON: 123456785')).types).toEqual(['regon']);
    expect(summarize(detectPii('dowód osobisty ABA300000')).types).toEqual(['id_card']);
  });

  it('nakładające się trafienia liczone raz — wygrywa dłuższe', () => {
    // Numer rachunku zawiera w sobie ciągi cyfr, które osobno mogłyby udać krótszy numer.
    const findings = detectPii(IBAN_OK);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.type).toBe('iban');
  });

  it('powtórzone wywołanie daje ten sam wynik (brak wycieku lastIndex)', () => {
    const text = `A ${PESEL_OK} B ${PESEL_OK}`;
    expect(detectPii(text)).toHaveLength(2);
    expect(detectPii(text)).toHaveLength(2);
  });
});

describe('detectPii — czego NIE wolno wykryć', () => {
  it('karta produktu oświetleniowego nie zawiera danych osobowych', () => {
    const text = [
      'Oprawa HighBay 150W, kod katalogowy 123456789, EAN 5901234123457.',
      'Strumień 21000 lm, skuteczność 140 lm/W, IP65, IK08.',
      'Wymiary 350x350x120 mm, masa 4,2 kg, gwarancja 5 lat.',
      'Norma PN-EN 60598-1, temperatura pracy -30..+50 st. C.',
    ].join('\n');
    expect(summarize(detectPii(text)).total).toBe(0);
  });

  it('dokument operacyjny z datami i identyfikatorami technicznymi jest czysty', () => {
    const text = [
      'Procedura obowiązuje od 2026-08-01 do 2027-07-31.',
      'Snapshot 2026-09-07_142337, sha256 a1b2c3d4e5f6.',
      'Timer kag-backup.timer, port 8887, wersja 0.8.0.',
    ].join('\n');
    expect(summarize(detectPii(text)).total).toBe(0);
  });

  it('jedenaście cyfr bez sumy kontrolnej to nie PESEL', () => {
    expect(summarize(detectPii('Numer seryjny 12345678901.')).total).toBe(0);
  });
});

describe('applyPiiPolicy', () => {
  const text = `Kontakt: jan@example.com, PESEL ${PESEL_OK}.`;

  it('off: nie skanuje i nie raportuje', () => {
    const result = applyPiiPolicy(text, 'off');
    expect(result.text).toBe(text);
    expect(result.report).toBeNull();
    expect(result.masked).toBe(false);
  });

  it('flag: raportuje, ale NIE zmienia treści', () => {
    const result = applyPiiPolicy(text, 'flag');
    expect(result.text).toBe(text);
    expect(result.masked).toBe(false);
    expect(result.report?.total).toBe(2);
  });

  it('mask: podmienia na placeholdery i nie gubi reszty zdania', () => {
    const result = applyPiiPolicy(text, 'mask');
    expect(result.masked).toBe(true);
    expect(result.text).toBe('Kontakt: [E-MAIL], PESEL [PESEL].');
    expect(result.text).not.toContain(PESEL_OK);
  });

  it('mask bez trafień nie zgłasza modyfikacji', () => {
    const result = applyPiiPolicy('Oprawa 150W, IP65.', 'mask');
    expect(result.masked).toBe(false);
    expect(result.report?.total).toBe(0);
  });

  it('raport nigdy nie niesie wartości — tylko typy i liczniki', () => {
    const report = applyPiiPolicy(text, 'flag').report;
    expect(JSON.stringify(report)).not.toContain(PESEL_OK);
    expect(JSON.stringify(report)).not.toContain('jan@example.com');
  });
});

describe('coercePiiPolicy', () => {
  it('nieznana wartość spada na domyślną, nie na off', () => {
    expect(coercePiiPolicy('mask')).toBe('mask');
    expect(coercePiiPolicy('nonsens')).toBe('flag');
    expect(coercePiiPolicy(undefined)).toBe('flag');
    expect(coercePiiPolicy(null)).toBe('flag');
  });
});
