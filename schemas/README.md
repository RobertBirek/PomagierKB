# Szablony schema DSL OpenSPG

`document_kb.schema.tpl` — generyczny szablon dokumentowej bazy wiedzy.
Placeholder `__NAMESPACE__` podmienia provisioning (walidacja: żaden placeholder nie może zostać).

Twarde zasady (patrz `.claude/skills/openspg-api/SKILL.md`):
- identyfikatory PO ANGIELSKU (bug #753), wcięcia TABEM, wszystkie wartości `Text`;
- relacje WYŁĄCZNIE jako właściwości `*RefId`/`*RefIds` (linie relacji DSL nie materializują się);
- `index: TextAndVector` tylko na polach krótkich: `Chunk.content` (≤1800 zn. — gwarantuje
  chunker; świadome odstępstwo od wzorca preview-only, pełny recall),
  `ReferenceDocument.contentPreview` (≤800), `summary` (≤400), `Topic.summary`;
- zmiany schematu tylko ADDYTYWNE (strażnik diffów w provisioningu).
