/** Outils MCP - acces au dashboard par role (permissions READ_STAFF / WRITE_MEMBERS). */
import { getOrCreateFeatureConfigs } from '../../../services/core/dashboardManagementService.js';
import prisma from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';
import { z } from 'zod';
import { type McpToolContext, SNOWFLAKE, err, ok } from '../toolkit.js';

type AccessRule = {
  roleId: string;
  canView: boolean;
  canModerate: boolean;
  canConfigure: boolean;
  canDelete: boolean;
};

export function registerDashboardAccessTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  const roleName = (roleId: string) =>
    client.guilds.cache.get(guildId)?.roles.cache.get(roleId)?.name ?? null;

  /**
   * Roles staff qui n'ont pas de regle sur la fonctionnalite, donc ceux que la
   * bascule en liste blanche vient d'exclure. Meme perimetre que la matrice du
   * dashboard : les grades de la hierarchie, plus le role moderateur.
   */
  const listExcludedStaffRoles = async (rules: Array<{ roleId: string }>) => {
    const [declared, guildConfig] = await Promise.all([
      prisma.staffRole.findMany({
        where: { guildId, enabled: true, discordRoleId: { not: null } },
        select: { discordRoleId: true },
      }),
      prisma.guild.findUnique({ where: { id: guildId }, select: { moderatorRoleId: true } }),
    ]);

    const staffRoleIds = new Set(
      [...declared.map((role) => role.discordRoleId), guildConfig?.moderatorRoleId].filter(
        (roleId): roleId is string => !!roleId
      )
    );

    const covered = new Set(rules.map((rule) => rule.roleId));
    return [...staffRoleIds]
      .filter((roleId) => !covered.has(roleId))
      .map((roleId) => ({ roleId, roleName: roleName(roleId) }));
  };

  const describeRules = (rules: AccessRule[]) =>
    rules.map((rule) => ({
      roleId: rule.roleId,
      roleName: roleName(rule.roleId),
      canView: rule.canView,
      canModerate: rule.canModerate,
      canConfigure: rule.canConfigure,
      canDelete: rule.canDelete,
    }));

  if (shouldRegister('READ_STAFF')) {
    server.registerTool(
      'get_dashboard_feature_access',
      {
        description:
          "Liste les droits d'acces au dashboard par role Discord, fonctionnalite par fonctionnalite. " +
          "`restricted: false` signifie qu'aucune regle n'existe et que tout le staff voit la section ; " +
          "`restricted: true` signifie que seuls les roles listes avec canView y ont acces. " +
          'Les administrateurs Discord ne sont jamais filtres. Requiert READ_STAFF.',
        inputSchema: {
          feature_key: z
            .string()
            .optional()
            .describe('Limiter a une fonctionnalite (ex: "tickets", "economy"). Toutes par defaut.'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ feature_key }) => {
        const configs = await getOrCreateFeatureConfigs(guildId);
        const selected = feature_key
          ? configs.filter((config) => config.featureKey === feature_key)
          : configs;

        if (feature_key && selected.length === 0) {
          return err(
            `Fonctionnalite « ${feature_key} » inconnue. Cles disponibles : ${configs.map((config) => config.featureKey).join(', ')}`
          );
        }

        return ok({
          features: selected.map((config) => ({
            featureKey: config.featureKey,
            featureName: config.featureName,
            enabled: config.enabled,
            restricted: (config.roleAccessByRole?.length ?? 0) > 0,
            rules: describeRules(config.roleAccessByRole ?? []),
          })),
        });
      })
    );
  }

  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'set_dashboard_feature_access',
      {
        description:
          "Accorde ou retire les droits d'un role Discord sur une section du dashboard. " +
          'Attention, le systeme est une liste blanche : tant qu\'une fonctionnalite n\'a aucune regle, ' +
          'tout le staff la voit ; des la premiere regle posee, tout role sans regle la perd. ' +
          'Pensez donc a accorder canView aux roles qui doivent garder la section, pas seulement a ' +
          "l'oublier pour celui qu'on veut exclure. Les droits non precises gardent leur valeur " +
          'actuelle sur une regle existante, et valent false sur une nouvelle. Requiert WRITE_MEMBERS.',
        inputSchema: {
          feature_key: z.string().describe('Cle de la fonctionnalite (ex: "tickets", "economy", "workflows")'),
          role: z.string().describe('Nom ou ID du role Discord concerne'),
          can_view: z.boolean().optional().describe('Voir la section et ses donnees'),
          can_moderate: z.boolean().optional().describe('Agir au quotidien sur la section'),
          can_configure: z.boolean().optional().describe('Modifier les reglages de la section'),
          can_delete: z.boolean().optional().describe('Supprimer dans la section'),
          remove: z
            .boolean()
            .optional()
            .describe(
              "Supprimer la regle de ce role. Retirer la derniere regle d'une fonctionnalite la " +
                'rouvre a tout le staff.'
            ),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard(
        'WRITE_MEMBERS',
        async ({ feature_key, role, can_view, can_moderate, can_configure, can_delete, remove, key_name }) => {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const discordRole = SNOWFLAKE.test(role)
            ? guild.roles.cache.get(role)
            : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());
          if (!discordRole) return err(`Role « ${role} » introuvable`);

          const configs = await getOrCreateFeatureConfigs(guildId);
          const config = configs.find((entry) => entry.featureKey === feature_key);
          if (!config) {
            return err(
              `Fonctionnalite « ${feature_key} » inconnue. Cles disponibles : ${configs.map((entry) => entry.featureKey).join(', ')}`
            );
          }

          const wasRestricted = (config.roleAccessByRole?.length ?? 0) > 0;

          if (remove) {
            await prisma.dashboardFeatureRoleAccess.deleteMany({
              where: { featureConfigId: config.id, roleId: discordRole.id },
            });
          } else {
            const current = config.roleAccessByRole?.find((entry) => entry.roleId === discordRole.id);
            const merged = {
              canView: can_view ?? current?.canView ?? false,
              canModerate: can_moderate ?? current?.canModerate ?? false,
              canConfigure: can_configure ?? current?.canConfigure ?? false,
              canDelete: can_delete ?? current?.canDelete ?? false,
            };

            await prisma.dashboardFeatureRoleAccess.upsert({
              where: { featureConfigId_roleId: { featureConfigId: config.id, roleId: discordRole.id } },
              create: { guildId, featureConfigId: config.id, roleId: discordRole.id, ...merged },
              update: merged,
            });
          }

          // Les droits de dashboard sont mis en cache sous le prefixe `guild:`.
          // Sans purge, un membre garde ses anciens acces jusqu'a une minute.
          await cache.invalidateGuild(guildId);

          const rules = await prisma.dashboardFeatureRoleAccess.findMany({
            where: { featureConfigId: config.id },
            orderBy: { roleId: 'asc' },
          });

          await audit(
            key_name,
            'Modification acces dashboard MCP',
            config.featureName,
            `${remove ? 'Retrait' : 'Mise a jour'} du role ${discordRole.name} sur « ${feature_key} »`
          );

          const restricted = rules.length > 0;

          // Seuls les roles staff peuvent perdre quelque chose : un role sans
          // acces au dashboard n'en avait de toute facon aucun. Lister tous les
          // roles du serveur ferait passer « Membre » ou « Clan A » pour des
          // victimes de la bascule.
          const excluded = restricted && !wasRestricted ? await listExcludedStaffRoles(rules) : [];

          return ok({
            ok: true,
            featureKey: config.featureKey,
            featureName: config.featureName,
            restricted,
            rules: describeRules(rules),
            ...(restricted && !wasRestricted
              ? {
                  warning:
                    "Premiere regle posee sur cette fonctionnalite : elle passe en liste blanche. Tout role " +
                    "absent de `rules` vient d'en perdre l'acces, hors administrateurs Discord.",
                  rolesNowExcluded: excluded,
                }
              : {}),
            ...(!restricted && wasRestricted
              ? {
                  warning:
                    "Derniere regle retiree : la fonctionnalite est de nouveau visible par tout le staff.",
                }
              : {}),
          });
        }
      )
    );
  }
}
