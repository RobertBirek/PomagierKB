# Runbook: usunięcie treści z bazy wiedzy „na wylot"

Kiedy: żądanie usunięcia danych (RODO), sprostowanie, wycofanie treści poufnej albo błędnej.

**Rzecz, którą trzeba zrozumieć zanim zaczniesz:** wycofanie dokumentu w panelu NIE kasuje
treści z grafu. Builder OpenSPG działa wyłącznie w trybie UPSERT, a jego endpointy `DELETE`
są niezweryfikowane w boju. Eksport wysyła wiersz-nagrobek (`semanticType=tombstone`,
`content=__WITHDRAWN__`), job kończy się sukcesem — i **węzeł zachowuje pełną treść**.
Sprawdzone empirycznie na produkcji 2026-09-06: po przebudowie StagingSmoke stary chunk
nadal miał 182 znaki treści i `semanticType="chunk"`, a `search/text` zwracał go z tym samym
score co jego następcę.

Dlatego usunięcie ma dwa poziomy i trzeba wykonać **oba**, jeśli treść ma zniknąć naprawdę.

## Poziom 1 — treść przestaje wychodzić do użytkowników (automatyczny)

Dzieje się samo, gdy wycofasz dokument i przebudujesz bazę:

1. Panel → Inbox → wycofaj szkic (albo promuj wersję zastępującą z `supersedes:`).
2. Panel → Bazy → **Zbuduj**.

Eksport zdejmuje chunki z `chunks_mirror`, oznacza id w rejestrze `graph_ids` jako `live = 0`,
a retrieval odsiewa takie trafienia — kanały OpenSPG mogą je jeszcze zwracać, ale nie trafią
ani do odpowiedzi, ani do cytowań. Po tym kroku treść jest **niedostępna**, ale nadal
**istnieje** w bazie grafu i we wszystkich kopiach zapasowych.

Weryfikacja: raport jakości bazy, check `graph_stale_nodes`. Od poprawki z 2026-09-06 check
odpytuje GRAF, a nie sam rejestr, więc powie wprost:

```
UWAGA: 3 wycofanych węzłów NADAL ma treść w grafie (…) — builder UPSERT nie nadpisał
nagrobka; retrieval je odsiewa po graph_ids, ale graf zachowuje treść
```

## Poziom 2 — treść znika z bazy grafu (ręczny, świadomy)

```bash
# 1. co zostałoby usunięte (nic nie zmienia)
sudo deploy/scripts/purge_graph_nodes.sh --namespace <NS>

# 2. wykonanie
sudo deploy/scripts/purge_graph_nodes.sh --namespace <NS> --apply
```

Skrypt bierze listę **wyłącznie** z rejestru (`graph_ids` gdzie `live = 0`), odsiewa id, których
w grafie już nie ma (nagrobki zostają w rejestrze na zawsze), i dopiero wtedy tnie partię do
`--limit` (domyślnie 1000). Dużą zaległość usuwa się więc **powtarzając tę samą komendę**
(`--limit 3000 --apply`) aż do komunikatu „wszystkie wycofane id są już poza grafem" — po każdej
partii skrypt sprawdza, że ubyło dokładnie tyle węzłów, ile było na liście. Kasowanie idzie w
podpartiach po 200 węzłów w osobnych transakcjach: chunk niesie treść i wektor, więc jedna
transakcja na 3 000 węzłów wysypała Neo4j (heap 2G, `OutOfMemoryError`) 2026-09-10 — usunięcie
zdążyło się zatwierdzić, serwer wymagał `docker restart release-openspg-neo4j`, a wpis audytu
trzeba było odtworzyć ręcznie. Skala zaległości:
liczba wierszy `live = 0` w rejestrze (2026-09-10, SubiektKB po 14 przebudowach: 11 734), nie „20"
z bramki jakości — bramka sprawdza w grafie tylko próbkę 20 id. Nie da się nim
skasować węzła należącego do stanu docelowego — podanie żywego id przez `--ids` kończy się
odrzuceniem:

```
ODRZUCONE (nie sa wycofane w rejestrze): CHUNK_2CE534D09DDB7838_001
```

Po usunięciu weryfikuje, że znikły dokładnie te węzły i **że nie ubyło nic poza nimi**
(porównuje liczbę węzłów przed i po z oczekiwaną), oraz dopisuje `graph.purge_nodes`
do łańcucha audytu z listą id.

Kontrola po fakcie — raport jakości powinien przejść na:
```
OK graph_stale_nodes: graf nie ma węzłów spoza stanu docelowego (sprawdzono próbkę 20; nagrobków w rejestrze: N, w tym już usunięte z grafu — patrz audyt graph.purge_nodes)
```

## Poziom 3 — kopie zapasowe

Snapshoty z retencją 14 dni (i miesięczne do 186 dni) **nadal zawierają usuniętą treść**.
Nie kasuj ich wybiórczo: unieważniłoby to `SHA256SUMS` i zepsuło cotygodniową weryfikację
odtwarzalności. Przy żądaniu usunięcia danych osobowych właściwą odpowiedzią jest
udokumentowanie okresu retencji kopii i tego, że treść zniknie z nich wraz z rotacją.

## Czego NIE robić

- **Nie wołaj endpointów `DELETE` OpenSPG.** Są niezweryfikowane; nie wiadomo, co robią
  z indeksami wektorowymi i metadanymi projektu.
- **Nie kasuj węzłów ręcznie w `cypher-shell`.** Skrypt istnieje właśnie po to, żeby lista
  pochodziła z rejestru, a operacja zostawiała ślad i weryfikowała bilans węzłów.
  Ręczne `MATCH … DELETE` nie ma żadnej z tych własności.
- **Nie usuwaj wierszy z `graph_ids`.** To rejestr tego, co wysłaliśmy do grafu —
  po usunięciu węzła wpis zostaje i jest dowodem, że wycofanie się odbyło.

## Kiedy sprawa jest pilna

Poziom 1 wystarcza, żeby treść przestała być dostępna dla użytkowników i agentów, i wykonuje
się w minutę (wycofanie + build). Poziom 2 można zrobić w dowolnym późniejszym momencie —
nie ma wyścigu, bo między nimi treść i tak nie wychodzi.
