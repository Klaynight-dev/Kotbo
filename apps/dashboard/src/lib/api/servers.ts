/**
 * Serveurs Discord de la personne connectee, avec ou sans Kotbo.
 *
 * Distinct de `authStore.guilds`, qui ne retient que les serveurs ou le bot est
 * deja present : ici on veut justement voir ceux ou il manque, pour proposer de
 * l'y ajouter.
 */
import { API_BASE_URL } from './client';

export type ManageableServer = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  botPresent: boolean;
  activated: boolean;
};

export type ManageableServersResponse = {
  guilds: ManageableServer[];
  clientId: string;
  /** Bitfield des permissions demandees a l'invitation, calcule par le bot. */
  invitePermissions: string;
  /** Discord n'a pas rendu la liste : l'ecran doit le dire plutot que d'afficher « aucun serveur ». */
  oauthUnavailable: boolean;
};

export async function fetchManageableServers(options?: { refresh?: boolean }): Promise<ManageableServersResponse> {
  const query = options?.refresh ? '?refresh=1' : '';
  const response = await fetch(`${API_BASE_URL}/api/user/servers${query}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    let message = `Server error: ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.error === 'string' && body.error.trim()) message = body.error.trim();
    } catch {
      // Corps illisible : le code HTTP suffit a decrire l'echec.
    }
    throw new Error(message);
  }

  const data = await response.json();
  return {
    guilds: Array.isArray(data?.guilds) ? data.guilds : [],
    clientId: typeof data?.clientId === 'string' ? data.clientId : '',
    invitePermissions: typeof data?.invitePermissions === 'string' ? data.invitePermissions : '0',
    oauthUnavailable: data?.oauthUnavailable === true,
  };
}

/**
 * Lien d'invitation du bot.
 *
 * Le bitfield vient du bot (`invitePermissions`), qui l'assemble a partir des
 * permissions dont il a reellement besoin : le recopier ici en dur le laisserait
 * derriver a la premiere fonctionnalite ajoutee.
 */
export function buildBotInviteUrl(clientId: string, permissions: string, guildId?: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    permissions,
    scope: 'bot applications.commands',
    response_type: 'code',
  });
  if (guildId) {
    params.set('guild_id', guildId);
    params.set('disable_guild_select', 'true');
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
