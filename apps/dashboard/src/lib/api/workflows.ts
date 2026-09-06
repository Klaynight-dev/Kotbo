/** Node Workflow Builder - automatisations par blocs. */
import type { ValidationIssue, WorkflowGraph } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerType: string;
  triggerEvent: string;
  runCount: number;
  successCount: number;
  failureCount: number;
  lastRunAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  graph: WorkflowGraph;
}

export interface WorkflowExecutionSummary {
  id: string;
  workflowId: string;
  status: 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  error: string | null;
  nodeVisits: number;
  iterations: number;
  resumeAt: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface WorkflowExecutionStep {
  id: string;
  order: number;
  nodeId: string;
  nodeType: string;
  status: 'OK' | 'ERROR' | 'SKIPPED';
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  error: string | null;
  durationMs: number;
}

export interface WorkflowExecutionDetail extends WorkflowExecutionSummary {
  steps: WorkflowExecutionStep[];
}

export interface SaveWorkflowPayload {
  name: string;
  description?: string | null;
  enabled: boolean;
  graph: WorkflowGraph;
}

export async function fetchWorkflows(
  guildId = authStore.selectedGuildId,
): Promise<{ workflows: WorkflowSummary[] }> {
  return dashboardRequest('/workflows', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Workflows):',
  });
}

export async function fetchWorkflow(
  id: string,
  guildId = authStore.selectedGuildId,
): Promise<{ workflow: WorkflowDetail }> {
  return dashboardRequest(`/workflows/${id}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Workflow):',
  });
}

export async function createWorkflow(
  payload: SaveWorkflowPayload,
  guildId = authStore.selectedGuildId,
): Promise<{ workflow: WorkflowDetail }> {
  // `silent` : la page annonce elle-même l'enregistrement, la duplication et la
  // suppression. Sans ça, le toast générique du client s'ajoute au sien.
  return dashboardRequest('/workflows', {
    method: 'POST',
    payload,
    guildId,
    silent: true,
    errorContext: 'API Error (Create Workflow):',
  });
}

export async function updateWorkflow(
  id: string,
  payload: SaveWorkflowPayload,
  guildId = authStore.selectedGuildId,
): Promise<{ workflow: WorkflowDetail }> {
  return dashboardRequest(`/workflows/${id}`, {
    method: 'PUT',
    payload,
    guildId,
    silent: true,
    errorContext: 'API Error (Update Workflow):',
  });
}

export async function toggleWorkflow(
  id: string,
  enabled: boolean,
  guildId = authStore.selectedGuildId,
): Promise<{ success: boolean }> {
  return dashboardRequest(`/workflows/${id}/toggle`, {
    method: 'POST',
    payload: { enabled },
    guildId,
    errorContext: 'API Error (Toggle Workflow):',
  });
}

export async function deleteWorkflow(
  id: string,
  guildId = authStore.selectedGuildId,
): Promise<{ success: boolean }> {
  return dashboardRequest(`/workflows/${id}`, {
    method: 'DELETE',
    guildId,
    silent: true,
    errorContext: 'API Error (Delete Workflow):',
  });
}

/** Valide un graphe côté serveur, sans l'enregistrer. */
export async function validateWorkflowGraph(
  graph: WorkflowGraph,
  guildId = authStore.selectedGuildId,
): Promise<{ issues: ValidationIssue[] }> {
  return dashboardRequest('/workflows/validate', {
    method: 'POST',
    payload: { graph },
    guildId,
    errorContext: 'API Error (Validate Workflow):',
  });
}

export async function fetchWorkflowExecutions(
  workflowId?: string,
  guildId = authStore.selectedGuildId,
): Promise<{ executions: WorkflowExecutionSummary[] }> {
  const query = workflowId ? `?workflowId=${workflowId}` : '';
  return dashboardRequest(`/workflows/executions${query}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Workflow Executions):',
  });
}

export async function fetchWorkflowExecution(
  executionId: string,
  guildId = authStore.selectedGuildId,
): Promise<{ execution: WorkflowExecutionDetail }> {
  return dashboardRequest(`/workflows/executions/${executionId}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Workflow Execution):',
  });
}
