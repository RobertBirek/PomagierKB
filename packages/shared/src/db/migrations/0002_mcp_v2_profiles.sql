-- 0002_mcp_v2_profiles.sql — MCP v2: nowe narzędzia read-only (kb_get_source,
-- kb_list_documents, kb_draft_status) dopisywane do istniejących profili, które
-- mają już kb_search — istniejące klucze zyskują bez klikania w panelu.
-- Data-only (schemat bez zmian); idempotentna dzięki warunkom NOT IN.

UPDATE mcp_profiles
SET tools_json = (
  SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(mcp_profiles.tools_json)
    UNION ALL SELECT 'kb_get_source'      WHERE 'kb_get_source'      NOT IN (SELECT value FROM json_each(mcp_profiles.tools_json))
    UNION ALL SELECT 'kb_list_documents'  WHERE 'kb_list_documents'  NOT IN (SELECT value FROM json_each(mcp_profiles.tools_json))
    UNION ALL SELECT 'kb_draft_status'    WHERE 'kb_draft_status'    NOT IN (SELECT value FROM json_each(mcp_profiles.tools_json))
  )
)
WHERE EXISTS (SELECT 1 FROM json_each(mcp_profiles.tools_json) WHERE value = 'kb_search');
