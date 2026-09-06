-- AlterEnum : ouverture des automatisations aux clés MCP.
--
-- WRITE_WORKFLOWS est la seule permission qui laisse déposer une règle
-- persistante, déclenchée ensuite sans intervention. Elle est donc séparée de
-- WRITE_SANCTIONS, qui n'agit qu'une fois : une clé peut sanctionner sans
-- pouvoir écrire d'automatisation, et l'inverse.
ALTER TYPE "McpKeyPermission" ADD VALUE IF NOT EXISTS 'READ_WORKFLOWS';
ALTER TYPE "McpKeyPermission" ADD VALUE IF NOT EXISTS 'WRITE_WORKFLOWS';
