/** Outils MCP - write workflows (permission WRITE_WORKFLOWS). */
import {
  compileRecipe,
  newStepId,
  type Recipe,
  type RecipeStep,
  type ValueRef,
} from '@kotbo/shared';
import {
  WorkflowValidationError,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  setWorkflowEnabled,
  updateWorkflow,
} from '../../../services/features/workflow/workflowService.js';
import { type McpToolContext, err, ok } from '../toolkit.js';
import { z } from 'zod';

/**
 * Une automatisation s'écrit ici sous sa forme lisible - un déclencheur, une
 * suite d'étapes - et non sous forme de graphe.
 *
 * C'est la même porte que celle de l'éditeur en phrases du dashboard : la
 * recette passe par `compileRecipe` puis par la validation, donc un agent ne
 * peut produire que des graphes que le moteur sait exécuter. Accepter des
 * nœuds et des fils bruts aurait ouvert la porte à des formes que rien ne
 * vérifie en amont.
 */

const valueRefSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('text'), template: z.string() })
    .describe('Texte, avec des jetons {member.displayName} tirés du contexte'),
  z.object({ from: z.literal('number'), value: z.number() }),
  z.object({ from: z.literal('boolean'), value: z.boolean() }),
  z.object({ from: z.literal('role'), roleId: z.string() }),
  z.object({ from: z.literal('channel'), channelId: z.string() }),
  z.object({ from: z.literal('context'), path: z.string() })
    .describe('Valeur du déclencheur, ex. « member » ou « message »'),
]);

const conditionTestSchema = z.object({
  condition: z.string().describe('Clé issue de get_workflow_catalog'),
  operator: z.string().optional(),
  value: valueRefSchema.optional(),
  negate: z.boolean().optional().describe('Inverse le test'),
});

const actionSchema = z.object({
  kind: z.literal('action'),
  action: z.string().describe('Type issu de get_workflow_catalog, ex. « SendMessage »'),
  values: z.record(valueRefSchema).describe('Une entrée par champ de l\'action'),
});

const waitSchema = z.object({
  kind: z.literal('wait'),
  seconds: z.number().int().min(1).max(2_592_000),
});

/**
 * L'imbrication est bornée plutôt qu'écrite récursivement : un schéma récursif
 * se convertit mal en JSON Schema, et trois niveaux couvrent tout ce que le
 * modèle sait dire - une condition close sa liste, rien ne peut la suivre.
 */
const leafStep = z.discriminatedUnion('kind', [actionSchema, waitSchema]);

const level2Step = z.discriminatedUnion('kind', [
  actionSchema,
  waitSchema,
  z.object({
    kind: z.literal('condition'),
    match: z.enum(['all', 'any']).default('all'),
    tests: z.array(conditionTestSchema).min(1),
    then: z.array(leafStep).default([]),
    otherwise: z.array(leafStep).default([]),
  }),
]);

const level1Step = z.discriminatedUnion('kind', [
  actionSchema,
  waitSchema,
  z.object({
    kind: z.literal('condition'),
    match: z.enum(['all', 'any']).default('all'),
    tests: z.array(conditionTestSchema).min(1),
    then: z.array(level2Step).default([]),
    otherwise: z.array(level2Step).default([]),
  }),
]);

const recipeSchema = z.object({
  trigger: z.object({
    type: z.string().describe('Type issu de get_workflow_catalog, ex. « OnMemberJoin »'),
    config: z.record(z.unknown()).optional()
      .describe('Réglages du déclencheur, ex. { "cron": "0 20 * * *" } pour OnSchedule'),
  }),
  steps: z.array(level1Step).default([]),
});

type RecipeInput = z.infer<typeof recipeSchema>;

/** Les identifiants d'étape sont générés ici : l'appelant n'a pas à les inventer. */
function toRecipe(input: RecipeInput): Recipe {
  const withIds = (steps: unknown[]): RecipeStep[] => steps.map((raw) => {
    const step = raw as Record<string, unknown>;

    if (step.kind === 'wait') {
      return { id: newStepId(), kind: 'wait', seconds: Number(step.seconds) };
    }

    if (step.kind === 'condition') {
      return {
        id: newStepId(),
        kind: 'condition',
        match: step.match === 'any' ? 'any' : 'all',
        tests: (step.tests as Record<string, unknown>[]).map((test) => ({
          id: newStepId('t'),
          condition: String(test.condition),
          ...(test.operator ? { operator: String(test.operator) } : {}),
          ...(test.value ? { value: test.value as ValueRef } : {}),
          ...(test.negate ? { negate: true } : {}),
        })),
        then: withIds((step.then as unknown[]) ?? []),
        otherwise: withIds((step.otherwise as unknown[]) ?? []),
      };
    }

    return {
      id: newStepId(),
      kind: 'action',
      action: String(step.action),
      values: (step.values ?? {}) as Record<string, ValueRef>,
    };
  });

  return {
    trigger: { type: input.trigger.type, ...(input.trigger.config ? { config: input.trigger.config } : {}) },
    steps: withIds(input.steps),
  };
}

/** Une recette refusée doit dire quoi corriger, pas seulement qu'elle est fausse. */
function reportFailure(error: unknown) {
  if (error instanceof WorkflowValidationError) {
    return err('Automatisation invalide', { issues: error.issues });
  }
  return err(`Erreur : ${error instanceof Error ? error.message : String(error)}`);
}

export function registerWriteWorkflowsTools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, audit, toolMeta } = ctx;

  if (!shouldRegister('WRITE_WORKFLOWS')) return;

  server.registerTool(
    'create_workflow',
    {
      description:
        "Crée une automatisation à partir d'une recette (un déclencheur, une suite d'étapes). "
        + 'Consultez get_workflow_catalog pour connaître les types et les champs acceptés. '
        + 'Requiert la permission WRITE_WORKFLOWS.',
      inputSchema: {
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        enabled: z.boolean().default(false)
          .describe('Une automatisation active se déclenche dès l\'enregistrement'),
        recipe: recipeSchema,
        key_name: z.string().optional().describe('Nom de la clé MCP (pour l\'audit)'),
      },
      _meta: toolMeta,
    },
    guard('WRITE_WORKFLOWS', async ({ name, description, enabled, recipe, key_name }) => {
      try {
        const graph = compileRecipe(toRecipe(recipe));
        const workflow = await createWorkflow(guildId, { name, description, enabled, graph }, `mcp:${key_name ?? 'inconnue'}`);

        await audit(
          key_name,
          'Création automatisation MCP',
          `« ${workflow.name} » sur ${workflow.triggerType}`,
          `Active: ${workflow.enabled} | Étapes: ${recipe.steps.length}`,
        );
        return ok({ id: workflow.id, name: workflow.name, enabled: workflow.enabled, triggerType: workflow.triggerType, graph });
      } catch (error) {
        return reportFailure(error);
      }
    }),
  );

  server.registerTool(
    'update_workflow',
    {
      description: "Remplace le contenu d'une automatisation existante. La recette fournie écrase l'ancienne.",
      inputSchema: {
        workflow_id: z.string(),
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        enabled: z.boolean().default(false),
        recipe: recipeSchema,
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_WORKFLOWS', async ({ workflow_id, name, description, enabled, recipe, key_name }) => {
      try {
        const graph = compileRecipe(toRecipe(recipe));
        const workflow = await updateWorkflow(guildId, workflow_id, { name, description, enabled, graph });
        if (!workflow) return err('Automatisation introuvable');

        await audit(
          key_name,
          'Modification automatisation MCP',
          `« ${workflow.name} » (${workflow_id})`,
          `Active: ${workflow.enabled} | Déclencheur: ${workflow.triggerType}`,
        );
        return ok({ id: workflow.id, name: workflow.name, enabled: workflow.enabled, graph });
      } catch (error) {
        return reportFailure(error);
      }
    }),
  );

  server.registerTool(
    'set_workflow_enabled',
    {
      description: 'Active ou met en pause une automatisation.',
      inputSchema: {
        workflow_id: z.string(),
        enabled: z.boolean(),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_WORKFLOWS', async ({ workflow_id, enabled, key_name }) => {
      const workflow = await getWorkflow(guildId, workflow_id);
      if (!workflow) return err('Automatisation introuvable');

      await setWorkflowEnabled(guildId, workflow_id, enabled);
      await audit(
        key_name,
        enabled ? 'Activation automatisation MCP' : 'Pause automatisation MCP',
        `« ${workflow.name} » (${workflow_id})`,
        `Déclencheur: ${workflow.triggerType}`,
      );
      return ok({ id: workflow_id, enabled });
    }),
  );

  server.registerTool(
    'delete_workflow',
    {
      description: 'Supprime définitivement une automatisation et son historique d\'exécutions.',
      inputSchema: {
        workflow_id: z.string(),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_WORKFLOWS', async ({ workflow_id, key_name }) => {
      const workflow = await getWorkflow(guildId, workflow_id);
      if (!workflow) return err('Automatisation introuvable');

      await deleteWorkflow(guildId, workflow_id);
      await audit(key_name, 'Suppression automatisation MCP', `« ${workflow.name} » (${workflow_id})`, `Déclencheur: ${workflow.triggerType}`);
      return ok({ deleted: true, id: workflow_id });
    }),
  );
}
