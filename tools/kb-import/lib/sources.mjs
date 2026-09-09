// Klasyfikacja plików źródłowych InsERT GT (nazwa → tytuł, kategoria z documentTypes KB, produkt,
// słowa kluczowe, streszczenie do nagłówka fragmentu) oraz kuracja plików z archiwów przykładów.
// Czysta logika — testy w test/sources.test.mjs.

export const CATEGORIES = {
  manual: 'podręcznik użytkownika',
  api: 'dokumentacja Sfera/COM/XML/EDI',
  db: 'opis tabeli bazy danych',
  sql: 'skrypt SQL',
  code: 'przykład kodu',
  changes: 'zmiany w wersji',
  install: 'instalacja i parametry',
  devices: 'sterowniki i urządzenia',
};

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/ą/g, 'a').replace(/ć/g, 'c').replace(/ę/g, 'e').replace(/ł/g, 'l').replace(/ń/g, 'n')
    .replace(/ó/g, 'o').replace(/ś/g, 's').replace(/[żź]/g, 'z')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'plik';
}

/** Reguły: wzorzec nazwy pliku (bez katalogu) → metadane. Pierwsze dopasowanie wygrywa. */
const RULES = [
  [/^Sfera_dla_InsERT_GT(-1)?\.pdf$/i, { title: 'Sfera dla InsERT GT — instrukcja', category: 'api', product: 'Sfera dla InsERT GT', keywords: ['Sfera', 'COM', 'automatyzacja', 'Subiekt GT', 'Rewizor GT', 'Gratyfikant GT', 'Gestor GT'], summary: 'Instrukcja Sfery dla InsERT GT: co to jest Sfera, licencjonowanie, instalacja, rejestracja, technologie (COM, VBA, .NET), pierwsze kroki i przykłady dla Subiekta, Gratyfikanta, Rewizora i Gestora GT.' }],
  [/^Wlasne_COM\.pdf$/i, { title: 'Własne rozwiązania COM w InsERT GT', category: 'api', product: 'InsERT GT', keywords: ['własne COM', 'rozszerzenia', 'InsZestCOM', 'zestawienia'], summary: 'Dokumentacja własnych rozwiązań COM (rozszerzeń) osadzanych w programach InsERT GT: interfejsy, rejestracja, przykład zmiany stawek VAT.' }],
  [/^Komunikacja_EDI/i, { title: 'Komunikacja EDI++ w InsERT GT', category: 'api', product: 'Subiekt GT', keywords: ['EDI++', 'EDI', 'wymiana danych', 'format pliku', 'import', 'eksport'], summary: 'Specyfikacja formatu wymiany danych EDI++ (wersja 1.12) używanego przez Subiekta GT do importu i eksportu dokumentów, kontrahentów i towarów.' }],
  [/^Wydruki_tekstowe\.pdf$/i, { title: 'Wydruki tekstowe w InsERT GT', category: 'manual', product: 'InsERT GT', keywords: ['wydruki tekstowe', 'drukarka igłowa', 'wzorce wydruku'], summary: 'Opis mechanizmu wydruków tekstowych (drukarki igłowe) w programach InsERT GT: konfiguracja, wzorce, kody sterujące.' }],
  [/^Sterowniki_urzadzen/i, { title: 'Sterowniki urządzeń zewnętrznych InsERT GT', category: 'devices', product: 'Subiekt GT', keywords: ['drukarka fiskalna', 'kasa fiskalna', 'czytnik', 'waga', 'sterowniki urządzeń'], summary: 'Lista i konfiguracja sterowników urządzeń zewnętrznych (drukarki i kasy fiskalne, czytniki kodów, wagi) współpracujących z InsERT GT.' }],
  [/^Fiskalizacja_zdalna/i, { title: 'Fiskalizacja zdalna w Subiekcie GT', category: 'devices', product: 'Subiekt GT', keywords: ['fiskalizacja zdalna', 'drukarka fiskalna', 'serwer fiskalny'], summary: 'Konfiguracja fiskalizacji zdalnej (drukarka fiskalna podłączona do innego stanowiska) w Subiekcie GT.' }],
  [/^Instalacja_i_parametry/i, { title: 'Instalacja i parametry uruchomieniowe InsERT GT', category: 'install', product: 'InsERT GT', keywords: ['instalacja', 'parametry uruchomieniowe', 'wiersz poleceń', 'SQL Server', 'wymagania'], summary: 'Instalacja programów InsERT GT, wymagania, parametry uruchomieniowe (przełączniki wiersza poleceń), praca z Microsoft SQL Server.' }],
  [/^Jak_zaczac_definiowanie/i, { title: 'Jak zacząć definiowanie składników płacowych (Gratyfikant GT)', category: 'manual', product: 'Gratyfikant GT', keywords: ['składniki płacowe', 'definiowanie składników', 'Gratyfikant'], summary: 'Wprowadzenie do definiowania własnych składników płacowych w Gratyfikancie GT.' }],
  [/^Jak_zaczac\.pdf$/i, { title: 'Jak zacząć pracę z InsERT GT', category: 'manual', product: 'InsERT GT', keywords: ['pierwsze kroki', 'jak zacząć', 'konfiguracja podmiotu'], summary: 'Przewodnik startowy InsERT GT: założenie podmiotu, pierwsze kroki w Subiekcie, Rachmistrzu, Rewizorze, Gratyfikancie i Gestorze GT.' }],
  [/^Dla_poczatkujacych/i, { title: 'InsERT GT dla początkujących', category: 'manual', product: 'InsERT GT', keywords: ['dla początkujących', 'podstawy obsługi'], summary: 'Podstawy obsługi programów linii InsERT GT dla początkujących użytkowników.' }],
  [/^InsERT_GT\.pdf$/i, { title: 'InsERT GT — podręcznik użytkownika', category: 'manual', product: 'InsERT GT', keywords: ['podręcznik', 'Subiekt GT', 'Rachmistrz GT', 'Rewizor GT', 'Gratyfikant GT', 'Gestor GT'], summary: 'Pełny podręcznik użytkownika systemu InsERT GT: wspólne elementy programów, Subiekt GT, Rachmistrz GT, Rewizor GT, Gratyfikant GT, Gestor GT.' }],
  [/^Biuro_GT/i, { title: 'Biuro GT — obsługa biura rachunkowego', category: 'manual', product: 'Biuro GT', keywords: ['Biuro GT', 'biuro rachunkowe', 'wiele podmiotów'], summary: 'Biuro GT: praca biura rachunkowego z wieloma podmiotami w InsERT GT, licencje, komunikacja z klientami.' }],
  [/^Czytaj_to/i, { title: 'Czytaj to — informacje o wersji 1.89 HF1', category: 'changes', product: 'InsERT GT', keywords: ['1.89', 'HF1', 'informacje o wersji', 'aktualizacja'], summary: 'Informacje o wersji InsERT GT 1.89 HF1: co zawiera aktualizacja, uwagi do instalacji.' }],
  [/^Zmiany_w_InsERT_GT/i, { title: 'Zmiany w InsERT GT — lista zmian w wersjach', category: 'changes', product: 'InsERT GT', keywords: ['lista zmian', 'nowości', 'wersja', 'zmiany w wersji'], summary: 'Lista zmian w kolejnych wersjach systemu InsERT GT (Subiekt, Rachmistrz, Rewizor, Gratyfikant, Gestor GT).' }],
  [/^(zielony|niebieski|czerwony)_PLUS/i, { title: 'PLUS dla InsERT GT', category: 'manual', product: 'InsERT GT', keywords: ['PLUS', 'zielony PLUS', 'niebieski PLUS', 'czerwony PLUS', 'rozszerzenia', 'abonament'], summary: 'Pakiet rozszerzeń PLUS dla InsERT GT: dodatkowe funkcje programów w ramach pakietu.' }],
  [/^Wspolpraca_SLICAN/i, { title: 'Współpraca centrali SLICAN CCT z Gestorem GT', category: 'devices', product: 'Gestor GT', keywords: ['SLICAN', 'centrala telefoniczna', 'CTI', 'Gestor GT'], summary: 'Integracja centrali telefonicznej SLICAN CCT z Gestorem GT (identyfikacja dzwoniącego, wybieranie numerów).' }],
  [/^HomeBanking\.zip$/i, { title: 'HomeBanking — format wymiany z bankiem', category: 'api', product: 'Subiekt GT', keywords: ['HomeBanking', 'przelewy', 'Elixir', 'XSLT', 'bankowość'], summary: 'Moduł HomeBanking InsERT GT: format przelewów, transformacje XSLT (Elixir), przykłady.' }],
  [/^Osadzanie_parserow_HB/i, { title: 'Osadzanie parserów HomeBanking', category: 'api', product: 'Subiekt GT', keywords: ['HomeBanking', 'parser', 'wyciąg bankowy', 'XSD'], summary: 'Osadzanie własnych parserów wyciągów bankowych HomeBanking w InsERT GT: schemat XSD, narzędzie importu.' }],
  [/^HopWin/i, { title: 'HopWin — wymiana danych XML z hurtownią', category: 'api', product: 'Subiekt GT', keywords: ['HopWin', 'XML', 'hurtownia', 'wymiana danych', 'XSD'], summary: 'HopWin: biblioteka i format XML wymiany danych (towary, komplety, dokumenty) między Subiektem GT a systemami zewnętrznymi; schematy XSD i przykłady.' }],
  [/^Wlasne_XML\.zip$/i, { title: 'Własne XML w InsERT GT', category: 'api', product: 'InsERT GT', keywords: ['własne XML', 'XSL', 'raporty XML', 'zestawienia'], summary: 'Mechanizm własnych rozwiązań XML (zestawienia i raporty definiowane XSL) w programach InsERT GT.' }],
  [/^Wlasne_XML_przyklady/i, { title: 'Własne XML — przykłady', category: 'code', product: 'InsERT GT', keywords: ['własne XML', 'XSL', 'przykład'], summary: 'Przykładowe pliki XML/XSL własnych rozwiązań XML dla InsERT GT.' }],
  [/^Wlasne_COM_przyklady/i, { title: 'Własne COM — przykład (zmiana stawek VAT)', category: 'code', product: 'Subiekt GT', keywords: ['własne COM', 'C++', 'ATL', 'InsZestCOM', 'stawki VAT'], summary: 'Przykładowy projekt własnego rozwiązania COM dla Subiekta GT (C++/ATL): zmiana stawek VAT.' }],
  [/^Przyklady_z_Roadshow/i, { title: 'Sfera — przykłady z Roadshow', category: 'code', product: 'Sfera dla InsERT GT', keywords: ['Sfera', 'przykład', 'VBA', 'Excel'], summary: 'Przykłady użycia Sfery dla InsERT GT pokazywane na Roadshow (opisy; arkusze Excel pominięte).' }],
  [/^Przyklady_ze_szkolenia/i, { title: 'Sfera — przykłady ze szkolenia', category: 'code', product: 'Sfera dla InsERT GT', keywords: ['Sfera', 'przykład', 'VB6', 'importer'], summary: 'Przykłady ze szkolenia Sfery dla InsERT GT: importer dokumentów w VB6, skrypty.' }],
  [/^Przyklady2?\.zip$/i, { title: 'Sfera — przykłady (skrypty i MS Office)', category: 'code', product: 'Sfera dla InsERT GT', keywords: ['Sfera', 'przykład', 'VBScript', 'MS Office', 'InterStore'], summary: 'Przykłady użycia Sfery dla InsERT GT: skrypty VBScript/WSF, integracje MS Office, opisy scenariuszy.' }],
  [/^GTA_dla_poczatkujacych\.zip$/i, { title: 'Sfera (GTA) dla początkujących', category: 'api', product: 'Sfera dla InsERT GT', keywords: ['Sfera', 'GTA', 'dla początkujących'], summary: 'Sfera dla początkujących (dokument .doc — pominięty, brak konwertera).' }],
  [/^Pomoc\/gta\.chm$/i, { title: 'Sfera dla InsERT GT — dokumentacja modelu obiektowego', category: 'api', product: 'Sfera dla InsERT GT', keywords: ['Sfera', 'model obiektowy', 'obiekt', 'metoda', 'atrybut', 'typ wyliczeniowy', 'COM', 'lista błędów'], summary: 'Dokumentacja programistyczna Sfery dla InsERT GT: model obiektowy (obiekty, kolekcje, atrybuty, metody, typy wyliczeniowe), pierwsze kroki, FAQ, lista błędów, definiowalne składniki płacowe.' }],
  [/^GTA\.chm$/, null], // starsza kopia gta.chm (2521 vs 2963 stron) — używamy Pomoc/gta.chm
  [/^(Pomoc\/)?InsERTGT\.chm$/i, { title: 'Pomoc InsERT GT', category: 'manual', product: 'InsERT GT', keywords: ['pomoc', 'Subiekt GT', 'Rachmistrz GT', 'Rewizor GT', 'Gratyfikant GT', 'Gestor GT', 'Kasiarz GT', 'mikroGratyfikant GT'], summary: 'System pomocy InsERT GT: informacje ogólne, budowa programów, praca z programem, terminy i pojęcia, moduły Subiekta, Gestora, Rachmistrza, Rewizora, Gratyfikanta, mikroGratyfikanta i Kasiarza GT.',
    // Opis struktury bazy = duplikat Dokumentacja_DB.xml (prepare-db); Lista_zmian.htm = podzbiór Lista_zmian_all.htm (płatne wyróżnione pogrubieniem)
    skipPages: /^(Opis_struktury_zbiorow_danych|Lista_zmian)\.htm$/i }],
  [/^(Pomoc\/)?InfoGT\.chm$/i, { title: 'InfoGT — informacje o produktach i licencjach', category: 'manual', product: 'InsERT GT', keywords: ['InfoGT', 'licencja', 'abonament', 'produkty', 'poprawki'], summary: 'InfoGT: informacje o produktach InsERT GT, licencjach, abonamencie i poprawkach.' }],
  [/^Pomoc\.zip$/i, null], // rozpakowane kopie CHM — te same strony (dedup po sha256)
  [/^Dokumentacja_bazy_danych/i, null], // obsługiwane przez prepare-db.mjs
  [/^Skrypty_SQL/i, null],
  [/^Zmiany_bazy_danych/i, null],
];

/** Metadane dla ścieżki pliku raw (null = pomiń świadomie; undefined = brak reguły). */
export function classifySource(path, productLabel = 'InsERT GT') {
  const name = path.split('/').pop();
  for (const [re, meta] of RULES) {
    if (re.test(path) || re.test(name)) {
      if (meta === null) return null;
      const slug = slugify(name.replace(/\.[^.]+$/, ''));
      return {
        ...meta,
        slug,
        category: CATEGORIES[meta.category],
        keywords: [productLabel, ...meta.keywords],
      };
    }
  }
  return undefined;
}

const TEXT_EXT = {
  '.txt': ['text', 'opis lub instrukcja tekstowa'],
  '.md': ['markdown', 'opis'],
  '.vbs': ['vb', 'skrypt VBScript'],
  '.wsf': ['xml', 'skrypt Windows Script File'],
  '.js': ['javascript', 'skrypt JScript'],
  '.bas': ['vb', 'moduł VBA/VB6'],
  '.cls': ['vb', 'klasa VB6'],
  '.frm': ['vb', 'formularz VB6 (kod)'],
  '.cpp': ['cpp', 'źródło C++'],
  '.h': ['cpp', 'nagłówek C++'],
  '.idl': ['idl', 'definicja interfejsu COM (IDL)'],
  '.cs': ['csharp', 'źródło C#'],
  '.vb': ['vb', 'źródło VB.NET'],
  '.sql': ['sql', 'skrypt SQL'],
  '.xml': ['xml', 'przykładowy plik XML'],
  '.xsl': ['xml', 'transformacja XSL'],
  '.xslt': ['xml', 'transformacja XSLT'],
  '.xsd': ['xml', 'schemat XSD'],
  '.csv': ['text', 'przykładowe dane CSV'],
  '.reg': ['text', 'wpis rejestru Windows'],
  '.ini': ['ini', 'plik konfiguracyjny'],
};
const BINARY_NOTE = {
  '.xls': 'arkusz Excel (makra VBA) — pominięty, brak konwertera',
  '.doc': 'dokument Word — pominięty, brak konwertera',
  '.exe': 'plik wykonywalny — pominięty',
  '.dll': 'biblioteka — pominięta',
};

/** Kuracja pliku z archiwum przykładów: {include, lang, describe, reason}. */
export function curateArchiveFile(name, size) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  const base = name.split('/').pop();
  if (/^(vssver\.scc|mssccprj\.scc|.*\.(vbp|vbw|epp|rc|rc2|rgs|vcproj|sln|resx|designer\.cs|dsp|dsw|ncb|suo|gif|png|jpg|bmp|ico))$/i.test(base)) {
    return { include: false };
  }
  if (BINARY_NOTE[ext]) return { include: false, reason: BINARY_NOTE[ext] };
  const t = TEXT_EXT[ext];
  if (!t) return { include: false, reason: `nieobsługiwany typ ${ext || '(bez rozszerzenia)'}` };
  if (size > 200_000) return { include: false, reason: `plik tekstowy za duży (${size} B)` };
  return { include: true, lang: t[0], describe: `${t[1]} z archiwum przykładów (${size} B).` };
}
