/** Outils MCP - read workflows (permission READ_WORKFLOWS). */
import {
  ACTION_LIBRARY,
  CONDITION_LIBRARY,
  TRIGGER_LIBRARY,
  decompileGraph,
  type WorkflowGraph,
} from '@kotbo/shared';
import {
  getExecutionDetail,
  getWorkflow,
  listExecutions,
  listWorkflows,
} from '../../../services/features/workflow/workflowService.js';
import { type McpToolContext, err, ok } from '../toolkit.js';
import { z } from 'zod';

export function registerReadWorkflowsTools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, toolMeta } = ctx;

  if (!shouldRegister('READ_WORKFLOWS')) return;

  /**
   * Ce qu'un workflow sait faire, avant même d'en écrire un.
   *
   * Sans cet inventaire, un agent devrait deviner les noms de déclencheurs et
   * d'actions, puis apprendre par l'échec. Le catalogue vient de la même source
   * que l'éditeur du dashboard : ce qui est listé ici est exactement ce que
   * `create_workflow` accepte.
   */
  server.registerTool(
    'get_workflow_catalog',
    {
      description:
        "Inventaire des déclencheurs, actions et conditions disponibles pour composer une automatisation. "
        + "À consulter avant create_workflow pour connaître les identifiants et les champs attendus.",
      inputSchema: {},
      _meta: toolMeta,
    },
    guard('READ_WORKFLOWS', async () => ok({
      triggers: TRIGGER_LIBRARY.map((trigger) => ({
        type: trigger.type,
        sentence: trigger.sentence,
        example: trigger.example,
      })),
      actions: ACTION_LIBRARY.map((action) => ({
        type: action.type,
        label: action.label,
        sentence: action.sentence,
        fields: action.fields.map((field) => ({
          key: field.key,
          label: field.label,
          kind: field.kind,
          // `option` distingue un réglage - couleur d'un embed - d'une valeur
          // branchée. Il se fournit dans `values` comme les autres, mais son
          // absence ne bloque jamais l'enregistrement : l'annoncer requis
          // aurait été trompeur.
          optional: (field.optional ?? false) || (field.option ?? false),
          setting: field.option ?? false,
          defaultValue: field.defaultValue ?? null,
        })),
      })),
      conditions: CONDITION_LIBRARY.map((condition) => ({
        key: condition.key,
        sentence: condition.sentence,
        requires: condition.requires,
        operators: condition.operators?.map((operator) => operator.value) ?? null,
        defaultOperator: condition.defaultOperator ?? null,
        valueKind: condition.valueKind ?? null,
      })),
    })),
  );

  server.registerTool(
    'get_workflows',
    {
      description: 'Liste les automatisations du serveur avec leurs statistiques d\'exécution.',
      inputSchema: {
        enabled: z.boolean().optional().describe('Filtre sur l\'état actif'),
      },
      _meta: toolMeta,
    },
    guard('READ_WORKFLOWS', async ({ enabled }) => {
      const workflows = await listWorkflows(guildId);
      const filtered = enabled === undefined
        ? workflows
        : workflows.filter((workflow) => workflow.enabled === enabled);

      return ok({
        total: filtered.length,
        workflows: filtered.map((workflow) => ({
          ...workflow,
          // Un workflow actif qui n'a jamais rien produit signale presque
          // toujours un déclencheur mal choisi ou une condition qui ne passe
          // jamais. Le dire ici évite un diagnostic à l'aveugle.
          neverRan: workflow.enabled && workflow.runCount === 0,
        })),
      });
    }),
  );

  server.registerTool(
    'get_workflow',
    {
      description:
        "Détail d'une automatisation. Renvoie sa forme lisible en étapes quand elle s'y prête, "
        + "et toujours son graphe brut.",
      inputSchema: {
        workflow_id: z.string().describe("Identifiant de l'automatisation"),
      },
      _meta: toolMeta,
    },
    guard('READ_WORKFLOWS', async ({ workflow_id }) => {
      const workflow = await getWorkflow(guildId, workflow_id);
      if (!workflow) return err('Automatisation introuvable');

      const graph = workflow.graph as unknown as WorkflowGraph;
      return ok({
        ...workflow,
        graph,
        // `null` quand le graphe ne se lit pas comme une suite d'étapes : il a
        // été écrit dans la vue graphe et sort du modèle linéaire.
        recipe: decompileGraph(graph),
      });
    }),
  );

  server.registerTool(
    'get_workflow_executions',
    {
      description: "Historique des exécutions, toutes automatisations ou une seule.",
      inputSchema: {
        workflow_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
      _meta: toolMeta,
    },
    guard('READ_WORKFLOWS', async ({ workflow_id, limit }) => ok({
      executions: await listExecutions(guildId, workflow_id, limit),
    })),
  );

  server.registerTool(
    'get_workflow_execution',
    {
      description:
        "Trace pas à pas d'une exécution : chaque nœud traversé, son état, sa durée, "
        + 'et les valeurs qui y sont entrées et sorties.',
      inputSchema: {
        execution_id: z.string(),
      },
      _meta: toolMeta,
    },
    guard('READ_WORKFLOWS', async ({ execution_id }) => {
      const execution = await getExecutionDetail(guildId, execution_id);
      return execution ? ok(execution) : err('Exécution introuvable');
    }),
  );
}
