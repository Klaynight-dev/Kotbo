import prisma from '../../utils/db.js';
import crypto from 'node:crypto';
import type { McpKeyPermission, McpApiKey } from '@prisma/client';
import type { Client } from 'discord.js';

/**
 * Le proprietaire de la cle a-t-il toujours acces au serveur ?
 *
 * Une cle ne portait que ses permissions : elle continuait de repondre apres
 * que son porteur ait perdu son role, ou meme quitte le serveur. Le controle
 * se fait a chaque appel, sur la meme resolution d'acces que le dashboard -
 * qui la met en cache, la verification ne coute donc pas une requete Discord
 * par outil appele.
 *
 * Une cle sans proprietaire est laissee telle quelle : ce sont celles
 * distribuees avant que ce champ existe, et les couper d'office arreterait des
 * integrations en service sans prevenir.
 *
 * Sans `client`, le controle est passe plutot que refuse. Tous les chemins
 * d'authentification le fournissent aujourd'hui ; le laisser optionnel evite
 * qu'un appelant oublie coupe toutes les cles du serveur d'un coup, la ou
 * l'oubli ne fait que ramener au comportement d'avant.
 */
const ownerStillAllowed = async (client: Client | undefined, key: McpApiKey): Promise<boolean> => {
  if (!key.ownerId || !client) return true;

  const { resolveDashboardAccess } = await import('../shared/core.js');
  const access = await resolveDashboardAccess(client, key.guildId, key.ownerId);
  return access.canViewDashboard;
};

export const hashMcpKey = (key: string): string => {
  return crypto.createHash('sha256').update(key).digest('hex');
};

export const generateMcpKey = (): { fullKey: string; displayKey: string } => {
  const fullKey = `mcp_${crypto.randomBytes(32).toString('hex')}`;
  const displayKey = `${fullKey.slice(0, 8)}...${fullKey.slice(-4)}`;
  return { fullKey, displayKey };
};

export const createMcpKey = async (
  guildId: string,
  name: string,
  permissions: McpKeyPermission[],
  ownerId?: string | null
) => {
  const { fullKey, displayKey } = generateMcpKey();
  const keyHash = hashMcpKey(fullKey);

  const record = await prisma.mcpApiKey.create({
    data: {
      guildId,
      name,
      keyHash,
      displayKey,
      permissions,
      ownerId: ownerId ?? null,
    },
  });

  return { ...record, fullKey };
};

export const getMcpKeys = async (guildId: string) => {
  return prisma.mcpApiKey.findMany({
    where: { guildId, isActive: true },
    select: {
      id: true,
      name: true,
      displayKey: true,
      permissions: true,
      isActive: true,
      lastUsedAt: true,
      createdAt: true,
      ownerId: true,
    },
    orderBy: { createdAt: 'desc' },
  });
};

export const deactivateMcpKey = async (guildId: string, keyId: string) => {
  return prisma.mcpApiKey.updateMany({
    where: { id: keyId, guildId },
    data: { isActive: false },
  });
};

export const verifyMcpKey = async (rawKey: string, guildId: string, client?: Client) => {
  const keyHash = hashMcpKey(rawKey);
  const key = await prisma.mcpApiKey.findUnique({ where: { keyHash } });

  if (!key || key.guildId !== guildId || !key.isActive) {
    return null;
  }

  if (!(await ownerStillAllowed(client, key))) return null;

  await prisma.mcpApiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  });

  return key;
};

// OAuth client_credentials flow: client_id = key.id, client_secret = full key
export const verifyMcpKeyByClientCredentials = async (
  clientId: string,
  clientSecret: string,
  guildId: string,
  client?: Client
) => {
  const key = await prisma.mcpApiKey.findFirst({
    where: { id: clientId, guildId, isActive: true },
  });

  if (!key) return null;

  // clientSecret is the full key - compare via hash
  const secretHash = hashMcpKey(clientSecret);
  if (secretHash !== key.keyHash) return null;

  if (!(await ownerStillAllowed(client, key))) return null;

  await prisma.mcpApiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  });

  return key;
};

export const getActiveMcpKeyById = async (keyId: string, guildId: string, client?: Client) => {
  const key = await prisma.mcpApiKey.findFirst({
    where: { id: keyId, guildId, isActive: true },
  });

  if (!key) return null;

  if (!(await ownerStillAllowed(client, key))) return null;

  await prisma.mcpApiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  });

  return key;
};

export const findActiveMcpKeyById = async (keyId: string, guildId: string) => {
  return prisma.mcpApiKey.findFirst({
    where: { id: keyId, guildId, isActive: true },
  });
};
