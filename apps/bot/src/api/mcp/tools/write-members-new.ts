/** Outils MCP - write members new (permission WRITE_MEMBERS). */
import { adminDeleteShopItem } from '../../../services/features/economyService.js';
import { clearWidgetForUser, pushWidgetForUser, refreshAllStaffWidgets } from '../../../services/integrations/widgetService.js';
import { guardAdminGrant, roleGrantsAdministrator } from '../../../services/moderation/adminLockService.js';
import { invalidateLevelConfigCache } from '../../../services/progression/levelingService.js';
import { generateAllStaffEvaluations, generateStaffEvaluation, updateEvaluationNote } from '../../../services/staff/staffEvaluationService.js';
import { updateCallPermissionConfig } from '../../../services/staff/staffLeadershipService.js';
import { addStaffMember, removeStaffMember } from '../../../services/staff/staffManagementService.js';
import prisma from '../../../utils/db.js';
import { PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, SNOWFLAKE, err, ok, resolveMember } from '../toolkit.js';

export function registerWriteMembersNewTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  // ── WRITE_MEMBERS (NEW) ────────────────────────────────────────────────────
  if (shouldRegister('WRITE_MEMBERS')) {
    // 1. rename_member
    server.registerTool(
      'rename_member',
      {
        description: 'Renomme (change le pseudo) d\'un membre sur le serveur Discord.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          nickname: z.string().describe('Le nouveau pseudo (vide pour réinitialiser)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, nickname, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const guild = client.guilds.cache.get(guildId);
        const discordMember = await guild?.members.fetch(resolved.userId).catch(() => null);
        if (!discordMember) return err('Membre introuvable sur le serveur Discord');

        try {
          await discordMember.setNickname(nickname || null, `Renommé via MCP par l'IA`);
          await audit(key_name, 'Modification pseudo MCP', resolved.label, `Pseudo appliqué: "${nickname || '(pseudo réinitialisé)'}"`);
          return ok({ ok: true, userId: resolved.userId, nickname: nickname || null });
        } catch (e) {
          return err(`Impossible de renommer le membre : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 2. manage_member_roles
    server.registerTool(
      'manage_member_roles',
      {
        description: 'Attribue ou retire des rôles Discord en masse pour un membre.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          roles: z.array(z.string()).describe('Liste des rôles à attribuer ou retirer (nom ou ID)'),
          action: z.enum(['add', 'remove']).describe('Action à réaliser : ajouter ou retirer les rôles'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, roles, action, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const guild = client.guilds.cache.get(guildId);
        const discordMember = await guild?.members.fetch(resolved.userId).catch(() => null);
        if (!discordMember) return err('Membre introuvable');

        const resolvedRoles = [];
        for (const rawRole of roles) {
          const rId = SNOWFLAKE.test(rawRole) ? rawRole : null;
          const role = rId ? guild?.roles.cache.get(rId) : guild?.roles.cache.find(r => r.name.toLowerCase() === rawRole.toLowerCase());
          if (role) resolvedRoles.push(role);
        }

        if (resolvedRoles.length === 0) return err('Aucun rôle valide trouvé');

        try {
          if (action === 'add') {
            if (!guild) return err('Serveur Discord introuvable');

            const allowedRoles: typeof resolvedRoles = [];
            const pendingRequestIds: string[] = [];
            for (const role of resolvedRoles) {
              if (roleGrantsAdministrator(role.permissions.bitfield)) {
                const guardResult = await guardAdminGrant({
                  client,
                  guild,
                  actorId: null,
                  requestedVia: 'MCP',
                  type: 'MEMBER_ROLE_GRANT',
                  permissionBits: role.permissions.bitfield,
                  targetRoleId: role.id,
                  targetRoleName: role.name,
                  targetMemberId: resolved.userId,
                  requestReason: `via MCP (clé: ${key_name ?? 'agent'})`,
                });
                if (guardResult.blocked) {
                  pendingRequestIds.push(guardResult.requestId);
                  continue;
                }
              }
              allowedRoles.push(role);
            }

            if (allowedRoles.length > 0) await discordMember.roles.add(allowedRoles);

            await audit(
              key_name,
              'Ajout rôles MCP',
              resolved.label,
              `Rôles ajoutés: ${allowedRoles.map(r => r.name).join(', ') || '(aucun)'}${pendingRequestIds.length > 0 ? ` | En attente d'approbation (Admin Lock): ${pendingRequestIds.length}` : ''}`
            );
            return ok({
              ok: true,
              userId: resolved.userId,
              roles: allowedRoles.map(r => ({ id: r.id, name: r.name })),
              ...(pendingRequestIds.length > 0
                ? { pendingApproval: { requestIds: pendingRequestIds, count: pendingRequestIds.length, message: "Certains rôles donnent ADMINISTRATOR : des demandes d'approbation ont été envoyées." } }
                : {}),
            });
          } else {
            await discordMember.roles.remove(resolvedRoles);
            await audit(key_name, 'Retrait rôles MCP', resolved.label, `Rôles modifiés: ${resolvedRoles.map(r => r.name).join(', ')}`);
            return ok({ ok: true, userId: resolved.userId, roles: resolvedRoles.map(r => ({ id: r.id, name: r.name })) });
          }
        } catch (e) {
          return err(`Erreur lors de l'assignation de rôles : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 3. promote_staff / demote_staff
    server.registerTool(
      'promote_staff',
      {
        description: 'Ajoute un membre au staff de Kotbo en BDD et attribue ses rôles de modération.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          grade: z.string().describe('Grade global (ex: "Modérateur", "Administrateur", "Direction")'),
          display_name: z.string().optional().describe('Nom d\'affichage dans l\'organigramme staff'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, grade, display_name, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const guild = client.guilds.cache.get(guildId);
        const discordMember = await guild?.members.fetch(resolved.userId).catch(() => null);
        if (!discordMember) return err('Membre introuvable sur Discord');

        try {
          const staffRecord = await addStaffMember(
            guildId,
            resolved.userId,
            grade,
            discordMember.user.tag,
            discordMember.user.username,
            display_name || discordMember.displayName,
            discordMember.displayAvatarURL()
          );

          // Synchroniser les rôles Discord correspondants
          const { syncStaffDiscordRoles } = await import('../../../services/staff/staffManagementService.js');
          await syncStaffDiscordRoles(guildId, resolved.userId, grade).catch(() => null);

          await audit(key_name, 'Promotion Staff MCP', resolved.label, `Grade appliqué: ${grade}`);
          return ok({ ok: true, userId: resolved.userId, grade, staffId: staffRecord?.id ?? null });
        } catch (e) {
          return err(`Erreur lors de la promotion staff : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'demote_staff',
      {
        description: 'Retire un membre du staff de Kotbo en BDD et retire ses rôles de modération.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          // removeStaffMember retire deja les roles Discord du staff (role de
          // base, role de test et roles de grade) : rien a synchroniser ensuite.
          await removeStaffMember(guildId, resolved.userId);

          await audit(key_name, 'Destitution Staff MCP', resolved.label, 'Membre retiré du staff');
          return ok({ ok: true, userId: resolved.userId });
        } catch (e) {
          return err(`Erreur lors de la destitution staff : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'generate_staff_evaluation',
      {
        description: 'Génère une évaluation de performance pour un ou tous les membres staff. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().optional().describe('Membre staff cible (nom, mention ou ID). Omis = tous les staff.'),
          period_days: z.number().int().min(7).max(365).default(30).describe('Période analysée en jours'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, period_days, key_name }) => {
        try {
          if (member) {
            const resolved = await resolveMember(guildId, member);
            if (!resolved.ok) return resolved.response;
            const evaluation = await generateStaffEvaluation(guildId, resolved.userId, period_days);
            await audit(key_name, 'Évaluation staff MCP', resolved.label, `Score: ${evaluation.overallScore}`);
            return ok({ ok: true, evaluation });
          }
          const evaluations = await generateAllStaffEvaluations(guildId, period_days);
          await audit(key_name, 'Évaluations staff MCP (batch)', '', `${evaluations.length} évaluation(s)`);
          return ok({ ok: true, count: evaluations.length, evaluations });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_staff_evaluation_note',
      {
        description: 'Ajoute ou met à jour la note manager sur une évaluation staff. Requiert WRITE_MEMBERS.',
        inputSchema: {
          evaluation_id: z.string().describe('ID de l\'évaluation'),
          manager_note: z.string().describe('Note du manager'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ evaluation_id, manager_note, key_name }) => {
        try {
          const existing = await prisma.staffEvaluation.findFirst({ where: { id: evaluation_id, guildId } });
          if (!existing) return err('Évaluation introuvable');
          const updated = await updateEvaluationNote(evaluation_id, manager_note);
          await audit(key_name, 'Note évaluation staff MCP', evaluation_id, manager_note.slice(0, 200));
          return ok({ ok: true, evaluation: updated });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_call_permission_config',
      {
        description: 'Configure qui peut planifier des appels staff (EVERYONE ou RESTRICTED par rôles/membres). Requiert WRITE_MEMBERS.',
        inputSchema: {
          mode: z.enum(['EVERYONE', 'RESTRICTED']).describe('Mode de permission'),
          allowed_role_ids: z.array(z.string()).optional().describe('Rôles autorisés (mode RESTRICTED)'),
          allowed_user_ids: z.array(z.string()).optional().describe('Membres autorisés (mode RESTRICTED)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ mode, allowed_role_ids, allowed_user_ids, key_name }) => {
        try {
          const config = await updateCallPermissionConfig(guildId, {
            mode,
            allowedRoleIds: allowed_role_ids ?? [],
            allowedUserIds: allowed_user_ids ?? [],
          });
          await audit(key_name, 'Config permissions appels MCP', mode, `Rôles: ${config.allowedRoleIds.length}, Membres: ${config.allowedUserIds.length}`);
          return ok({ ok: true, config });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'activate_widget',
      {
        description: 'Active le widget Discord de profil staff pour un membre. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Membre staff (nom, mention ou ID)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          await prisma.widgetSubscription.upsert({
            where: { guildId_userId: { guildId, userId: resolved.userId } },
            update: { enabled: true },
            create: { guildId, userId: resolved.userId, enabled: true },
          });
          const result = await pushWidgetForUser(guildId, resolved.userId);
          await audit(key_name, 'Activation widget MCP', resolved.label, result.ok ? 'OK' : 'Échec push');
          return ok({ ok: true, userId: resolved.userId, pushResult: result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'deactivate_widget',
      {
        description: 'Désactive le widget Discord de profil staff pour un membre. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Membre staff (nom, mention ou ID)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          await prisma.widgetSubscription.updateMany({
            where: { guildId, userId: resolved.userId },
            data: { enabled: false },
          });
          const result = await clearWidgetForUser(resolved.userId);
          await audit(key_name, 'Désactivation widget MCP', resolved.label, '');
          return ok({ ok: true, userId: resolved.userId, clearResult: result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'refresh_widget',
      {
        description: 'Rafraîchit le widget Discord de profil staff pour un membre. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Membre staff (nom, mention ou ID)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          const result = await pushWidgetForUser(guildId, resolved.userId);
          await audit(key_name, 'Refresh widget MCP', resolved.label, result.ok ? 'OK' : 'Échec');
          return ok({ ok: true, userId: resolved.userId, pushResult: result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'refresh_all_widgets',
      {
        description: 'Rafraîchit les widgets Discord de tous les staff abonnés actifs du serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name }) => {
        try {
          const result = await refreshAllStaffWidgets(guildId);
          await audit(key_name, 'Refresh widgets MCP (global)', guildId, `${result.success ?? 0} succès`);
          return ok({ ok: true, ...result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 4. get_nickname_moderation_config / update_nickname_moderation_config
    server.registerTool(
      'get_nickname_moderation_config',
      {
        description: 'Récupère les réglages de modération automatique de pseudos.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async () => {
        const guild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            autoNicknameModerationEnabled: true,
            nicknameModerationWhitelist: true,
            nicknameModerationBypass: true,
            nickModOnJoin: true,
            nickModOnUpdate: true,
            nickModCheckInvisible: true,
            nickModCheckGlobal: true,
            nickModCheckCustom: true,
          }
        });
        return ok(guild);
      })
    );

    server.registerTool(
      'update_nickname_moderation_config',
      {
        description: 'Met à jour la configuration de modération automatique de pseudos.',
        inputSchema: {
          enabled: z.boolean().optional(),
          on_join: z.boolean().optional(),
          on_update: z.boolean().optional(),
          check_invisible: z.boolean().optional(),
          check_global: z.boolean().optional(),
          check_custom: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ enabled, on_join, on_update, check_invisible, check_global, check_custom, key_name }) => {
        try {
          await prisma.guild.update({
            where: { id: guildId },
            data: {
              ...(enabled !== undefined ? { autoNicknameModerationEnabled: enabled } : {}),
              ...(on_join !== undefined ? { nickModOnJoin: on_join } : {}),
              ...(on_update !== undefined ? { nickModOnUpdate: on_update } : {}),
              ...(check_invisible !== undefined ? { nickModCheckInvisible: check_invisible } : {}),
              ...(check_global !== undefined ? { nickModCheckGlobal: check_global } : {}),
              ...(check_custom !== undefined ? { nickModCheckCustom: check_custom } : {}),
            }
          });

          await audit(key_name, 'Configuration pseudos MCP', 'Mise à jour des paramètres de modération de pseudos', '');
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 5. add_blocked_nickname_word / remove_blocked_nickname_word
    server.registerTool(
      'add_blocked_nickname_word',
      {
        description: 'Ajoute un mot interdit/regex dans la blacklist de pseudos du serveur.',
        inputSchema: {
          word: z.string().describe('Le mot ou le motif regex interdit'),
          category: z.string().default('custom').describe('Catégorie du mot (ex: racist, toxic, custom)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ word, category, key_name }) => {
        try {
          const bw = await prisma.bannedWord.create({
            data: {
              guildId,
              word,
              category,
              enabled: true
            }
          });

          await audit(key_name, 'Blacklist pseudos MCP', word, `Catégorie: ${category}`);
          return ok({ ok: true, wordId: bw.id, word });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'remove_blocked_nickname_word',
      {
        description: 'Supprime un mot de la blacklist de pseudos du serveur.',
        inputSchema: {
          word: z.string().describe('Le mot exact à enlever de la blacklist'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ word, key_name }) => {
        try {
          await prisma.bannedWord.deleteMany({
            where: { guildId, word }
          });

          await audit(key_name, 'Whitelist pseudos MCP', word, 'Retiré de la blacklist');
          return ok({ ok: true, word });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 6. run_nickname_rescan
    server.registerTool(
      'run_nickname_rescan',
      {
        description: 'Exécute un scan massif des pseudos des membres du serveur et renomme ceux non conformes.',
        inputSchema: {
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        try {
          const { scanAndModeratePseudos } = await import('../../../services/moderation/nicknameModerationService.js');
          const scanRes = await scanAndModeratePseudos(guild);

          await audit(key_name, 'Rescan pseudos MCP', 'Scan manuel déclenché par l\'IA', `Scannés: ${scanRes.scannedCount} | Renommés: ${scanRes.renamedCount}`);
          return ok(scanRes);
        } catch (e) {
          return err(`Erreur rescan: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 7. get_leveling_config / update_leveling_config
    server.registerTool(
      'get_leveling_config',
      {
        description: 'Récupère la configuration du système de progression et leveling (XP).',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async () => {
        const config = await prisma.levelConfig.findUnique({
          where: { guildId },
          select: {
            enabled: true,
            xpMin: true,
            xpMax: true,
            cooldownSeconds: true,
            vocalXpPerMin: true,
            levelUpChannelId: true,
            levelUpMessage: true,
            stackRewards: true,
            ignoredChannels: true,
            ignoredRoles: true,
          }
        });
        return ok(config);
      })
    );

    server.registerTool(
      'update_leveling_config',
      {
        description: 'Met à jour les paramètres de progression/gains d\'XP du serveur.',
        inputSchema: {
          enabled: z.boolean().optional(),
          xp_min: z.number().int().min(1).optional(),
          xp_max: z.number().int().min(1).optional(),
          cooldown: z.number().int().min(0).optional(),
          vocal_xp: z.number().int().min(0).optional(),
          announce_channel: z.string().optional().describe('ID salon, "DM", ou vide (même salon)'),
          announce_message: z.string().optional().describe('Message (ex: "Félicitations {user} ! Tu passes au niveau **{level}** ! 🎉")'),
          stack_rewards: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ enabled, xp_min, xp_max, cooldown, vocal_xp, announce_channel, announce_message, stack_rewards, key_name }) => {
        try {
          await prisma.levelConfig.update({
            where: { guildId },
            data: {
              ...(enabled !== undefined ? { enabled } : {}),
              ...(xp_min !== undefined ? { xpMin: xp_min } : {}),
              ...(xp_max !== undefined ? { xpMax: xp_max } : {}),
              ...(cooldown !== undefined ? { cooldownSeconds: cooldown } : {}),
              ...(vocal_xp !== undefined ? { vocalXpPerMin: vocal_xp } : {}),
              ...(announce_channel !== undefined ? { levelUpChannelId: announce_channel || null } : {}),
              ...(announce_message !== undefined ? { levelUpMessage: announce_message } : {}),
              ...(stack_rewards !== undefined ? { stackRewards: stack_rewards } : {}),
            }
          });

          await invalidateLevelConfigCache(guildId);

          await audit(key_name, 'Configuration progression MCP', 'Mise à jour de la config de progression', '');
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 8. create_level_role_reward / remove_level_role_reward
    server.registerTool(
      'create_level_role_reward',
      {
        description: 'Configure ou met à jour un rôle Discord offert à un niveau spécifique.',
        inputSchema: {
          level: z.number().int().min(1).describe('Niveau requis'),
          role: z.string().describe('Nom ou ID du rôle Discord'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ level, role, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        const rId = SNOWFLAKE.test(role) ? role : null;
        const discordRole = rId ? guild?.roles.cache.get(rId) : guild?.roles.cache.find(r => r.name.toLowerCase() === role.toLowerCase());
        if (!discordRole) return err(`Rôle "${role}" introuvable`);

        try {
          const reward = await prisma.levelRoleReward.upsert({
            where: { guildId_level: { guildId, level } },
            update: { roleId: discordRole.id },
            create: { guildId, level, roleId: discordRole.id }
          });

          await audit(key_name, 'Configuration progression MCP', `Récompense niveau ${level}`, `Rôle: ${discordRole.name}`);
          return ok({ ok: true, rewardId: reward.id, level, roleName: discordRole.name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'remove_level_role_reward',
      {
        description: 'Supprime la récompense de rôle pour un niveau.',
        inputSchema: {
          level: z.number().int().min(1).describe('Niveau requis'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ level, key_name }) => {
        try {
          await prisma.levelRoleReward.deleteMany({
            where: { guildId, level }
          });

          await audit(key_name, 'Configuration progression MCP', `Suppression récompense niveau ${level}`, '');
          return ok({ ok: true, level });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 9. update_economy_config
    server.registerTool(
      'update_economy_config',
      {
        description: 'Configure le système d\'économie RPG de Kotbo.',
        inputSchema: {
          currency_name: z.string().optional().describe('Nom de la monnaie (ex: "Kotcoins")'),
          currency_emoji: z.string().optional().describe('Emoji de la monnaie'),
          daily_min: z.number().int().min(0).optional(),
          daily_max: z.number().int().min(0).optional(),
          max_energy: z.number().int().min(1).optional(),
          energy_recovery_per_hour: z.number().int().min(0).optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ currency_name, currency_emoji, daily_min, daily_max, max_energy, energy_recovery_per_hour, key_name }) => {
        try {
          await prisma.economyConfig.upsert({
            where: { guildId },
            update: {
              ...(currency_name !== undefined ? { currencyName: currency_name } : {}),
              ...(currency_emoji !== undefined ? { currencyEmoji: currency_emoji } : {}),
              ...(daily_min !== undefined ? { dailyRewardMin: daily_min } : {}),
              ...(daily_max !== undefined ? { dailyRewardMax: daily_max } : {}),
              ...(max_energy !== undefined ? { maxEnergy: max_energy } : {}),
              ...(energy_recovery_per_hour !== undefined ? { energyRecoveryPerHour: energy_recovery_per_hour } : {}),
            },
            create: {
              guildId,
              currencyName: currency_name || 'Pièces',
              currencyEmoji: currency_emoji || '🪙',
              dailyRewardMin: daily_min || 50,
              dailyRewardMax: daily_max || 150,
              maxEnergy: max_energy || 100,
              energyRecoveryPerHour: energy_recovery_per_hour || 10,
            }
          });

          await audit(key_name, 'Configuration économie MCP', 'Mise à jour des paramètres d\'économie', '');
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 10. create_rpg_shop_item
    server.registerTool(
      'create_rpg_shop_item',
      {
        description: 'Crée un nouvel objet dans la boutique RPG.',
        inputSchema: {
          id: z.string().describe('ID unique de l\'objet (ex: "iron_sword")'),
          name: z.string().describe('Nom de l\'objet'),
          description: z.string().describe('Description de ses effets'),
          type: z.enum(['WEAPON', 'ARMOR', 'POTION', 'USABLE', 'MATERIAL', 'QUEST']),
          price: z.number().int().min(0).describe('Prix d\'achat'),
          purchasable: z.boolean().default(true),
          atk_bonus: z.number().int().default(0),
          def_bonus: z.number().int().default(0),
          hp_restore: z.number().int().default(0),
          energy_restore: z.number().int().default(0),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, name, description, type, price, purchasable, atk_bonus, def_bonus, hp_restore, energy_restore, key_name }) => {
        try {
          const existing = await prisma.rpgItem.findUnique({
            where: { id }
          });

          if (existing && existing.guildId !== guildId) {
            return err("Cet objet existe déjà et appartient à un autre serveur ou est un objet global.");
          }

          const item = await prisma.rpgItem.upsert({
            where: { id },
            update: {
              name,
              description,
              type,
              price,
              purchasable,
              atkBonus: atk_bonus,
              defBonus: def_bonus,
              hpRestore: hp_restore,
              energyRestore: energy_restore,
            },
            create: {
              guildId,
              id,
              name,
              description,
              type,
              price,
              purchasable,
              atkBonus: atk_bonus,
              defBonus: def_bonus,
              hpRestore: hp_restore,
              energyRestore: energy_restore,
            }
          });

          // Les butins des monstres désignent leur objet par son nom : un renommage doit
          // les suivre, sinon la créature annonce un butin que plus rien ne peut verser.
          if (existing && existing.name !== item.name) {
            const { syncDropReferences } = await import('../../../services/features/rpg/rpgBestiaryService.js');
            await syncDropReferences(guildId, existing.name, item.name);
          }

          await audit(key_name, 'Configuration économie MCP', `Nouvel objet boutique RPG : ${name}`, `Type: ${type} | Prix: ${price}`);
          return ok({ ok: true, itemId: item.id, name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_rpg_shop_item',
      {
        description: 'Supprime un objet de la boutique RPG. Requiert WRITE_MEMBERS.',
        inputSchema: {
          id: z.string().describe('ID unique de l\'objet à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const { item, unequippedCount } = await adminDeleteShopItem(guildId, id);

          await audit(key_name, 'Configuration économie MCP', `Objet boutique RPG supprimé: ${item.name}`, `ID: ${id}${unequippedCount > 0 ? ` | Déséquipé de ${unequippedCount} profil(s)` : ''}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_role',
      {
        description: 'Crée un nouveau rôle sur le serveur Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().describe('Nom du rôle'),
          color: z.string().optional().describe('Couleur hexadécimale (ex: "#FF0000")'),
          hoist: z.boolean().optional().describe('Afficher les membres ayant ce rôle séparément des autres'),
          mentionable: z.boolean().optional().describe('Permettre à tout le monde de mentionner ce rôle'),
          permissions: z.array(z.string()).optional().describe('Liste de permissions Discord à accorder (ex: ["ManageGuild","KickMembers","BanMembers"])'),
          reason: z.string().optional().describe('Raison de la création (pour l\'audit Discord)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, color, hoist, mentionable, permissions, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          let permBits: bigint | undefined;
          if (permissions && permissions.length > 0) {
            permBits = 0n;
            for (const p of permissions) {
              const bit = (PermissionFlagsBits as any)[p];
              if (bit === undefined) return err(`Permission inconnue : « ${p} ». Exemples valides : ViewChannel, SendMessages, Administrator, ManageGuild…`);
              permBits |= bit;
            }
          }

          if (permBits !== undefined && roleGrantsAdministrator(permBits)) {
            const guardResult = await guardAdminGrant({
              client,
              guild,
              actorId: null,
              requestedVia: 'MCP',
              type: 'ROLE_CREATE',
              permissionBits: permBits,
              targetRoleName: name,
              pendingRoleCreatePayload: {
                name,
                color: color || undefined,
                hoist: hoist ?? false,
                mentionable: mentionable ?? false,
                reason: reason || 'Créé via MCP (approuvé)',
              },
              requestReason: `via MCP (clé: ${key_name ?? 'agent'})`,
            });
            if (guardResult.blocked) {
              await audit(key_name, 'Création rôle MCP - bloquée (Admin Lock)', name, `Demande ${guardResult.requestId}`);
              return ok({
                ok: true,
                pendingApproval: true,
                requestId: guardResult.requestId,
                message: "Ce rôle inclut ADMINISTRATOR : une demande d'approbation a été envoyée, le rôle ne sera créé qu'après validation.",
              });
            }
          }

          const role = await guild.roles.create({
            name,
            color: color || undefined,
            hoist: hoist ?? false,
            mentionable: mentionable ?? false,
            permissions: permBits !== undefined ? permBits : undefined,
            reason: reason || 'Créé via MCP',
          });

          await audit(key_name, 'Création rôle MCP', name, `ID: ${role.id}`);
          return ok({ ok: true, roleId: role.id, name: role.name });
        } catch (e) {
          return err(`Erreur lors de la création du rôle : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_role',
      {
        description: 'Met à jour les propriétés d\'un rôle existant sur le serveur Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          role: z.string().describe('Nom ou ID du rôle à modifier'),
          name: z.string().optional().describe('Nouveau nom du rôle'),
          color: z.string().optional().describe('Nouvelle couleur hexadécimale (ex: "#00FF00")'),
          hoist: z.boolean().optional().describe('Afficher les membres ayant ce rôle séparément'),
          mentionable: z.boolean().optional().describe('Rendre le rôle mentionnable'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ role, name, color, hoist, mentionable, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const roleId = SNOWFLAKE.test(role) ? role : null;
          const discordRole = roleId
            ? guild.roles.cache.get(roleId)
            : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

          if (!discordRole) return err(`Rôle « ${role} » introuvable`);

          const updated = await discordRole.edit({
            name: name !== undefined ? name : undefined,
            color: color !== undefined ? color : undefined,
            hoist: hoist !== undefined ? hoist : undefined,
            mentionable: mentionable !== undefined ? mentionable : undefined,
            reason: reason || 'Modifié via MCP',
          });

          await audit(key_name, 'Mise à jour rôle MCP', discordRole.name, `ID: ${discordRole.id}`);
          return ok({ ok: true, roleId: discordRole.id, name: updated.name });
        } catch (e) {
          return err(`Erreur lors de la modification du rôle : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_role',
      {
        description: 'Supprime un rôle existant sur le serveur Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          role: z.string().describe('Nom ou ID du rôle à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ role, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const roleId = SNOWFLAKE.test(role) ? role : null;
          const discordRole = roleId
            ? guild.roles.cache.get(roleId)
            : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

          if (!discordRole) return err(`Rôle « ${role} » introuvable`);

          await discordRole.delete(reason || 'Supprimé via MCP');

          await audit(key_name, 'Suppression rôle MCP', discordRole.name, `ID: ${discordRole.id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur lors de la suppression du rôle : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

  }
}
