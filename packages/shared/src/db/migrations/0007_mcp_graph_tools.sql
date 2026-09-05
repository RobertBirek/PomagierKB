-- 0007_mcp_graph_tools.sql — modernizacja MCP: nowe narzędzia read-only
-- (kb_entity_get, kb_graph_neighbors, kb_claim_verify) dopisywane do profili
-- z kb_search (wzorzec 0002). Data-only, idempotentna.

UPDATE mcp_profiles
SET tools_json = (
  SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(mcp_profiles.tools_json)
    UNION ALL SELECT 'kb_entity_get'       WHERE 'kb_entity_get'       NOT IN (SELECT value FROM json_each(mcp_profiles.tools_json))
    UNION ALL SELECT 'kb_graph_neighbors'  WHERE 'kb_graph_neighbors'  NOT IN (SELECT value FROM json_each(mcp_profiles.tools_json))
    UNION ALL SELECT 'kb_claim_verify'     WHERE 'kb_claim_verify'     NOT IN (SELECT value FROM json_each(mcp_profiles.tools_json))
  )
)
WHERE EXISTS (SELECT 1 FROM json_each(mcp_profiles.tools_json) WHERE value = 'kb_search');
