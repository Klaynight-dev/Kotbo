/**
 * Configuration du module tickets.
 *
 * Attention a `updateTicketsConfig` : la route ne fusionne pas, elle remplace.
 * Un champ absent du corps est reecrit a sa valeur par defaut, pas laisse en
 * place. Tout appelant qui ne touche qu'a un reglage doit donc relire la
 * configuration, la modifier, et la renvoyer entiere - c'est ce que fait
 * `patchTicketsConfig`.
 */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type TicketTypeConfig = {
  id: string;
  label: string;
  description?: string | null;
  emoji?: string | null;
  buttonStyle?: 'PRIMARY' | 'SECONDARY' | 'SUCCESS' | 'DANGER';
};

export async function fetchTicketsConfig(
  guildId = authStore.selectedGuildId,
): Promise<Record<string, unknown> | null> {
  return dashboardRequest('/tickets/config', {
    method: 'GET',
    guildId,
    silent: true,
    errorContext: 'API Error (Tickets Config):',
  });
}

export async function updateTicketsConfig(
  config: Record<string, unknown>,
  guildId = authStore.selectedGuildId,
  /** Muet quand l'ecriture vient du parcours : l'ecran suivant fait la confirmation. */
  options: { silent?: boolean } = {},
) {
  return dashboardRequest('/tickets/config', {
    method: 'PATCH',
    payload: config,
    guildId,
    silent: options.silent,
    errorContext: 'API Error (Update Tickets Config):',
  });
}

/**
 * Modifie quelques reglages sans emporter les autres.
 *
 * La lecture prealable n'est pas un luxe : elle est ce qui distingue « je
 * change la couleur du panneau » de « je remets toute la configuration des
 * tickets a zero en changeant la couleur du panneau ».
 */
export async function patchTicketsConfig(
  patch: Record<string, unknown>,
  guildId = authStore.selectedGuildId,
  options: { silent?: boolean } = {},
) {
  const current = (await fetchTicketsConfig(guildId)) ?? {};
  return updateTicketsConfig({ ...current, ...patch }, guildId, options);
}
