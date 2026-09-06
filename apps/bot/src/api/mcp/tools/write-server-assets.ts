/** Outils MCP - write server assets (permission WRITE_MEMBERS). */
import { guardAdminGrant, roleGrantsAdministrator } from '../../../services/moderation/adminLockService.js';
import { addXp, removeXp } from '../../../services/progression/levelingService.js';
import { MAX_XP } from '@kotbo/shared';
import prisma from '../../../utils/db.js';
import { PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { MENTION_CHANNEL, type McpToolContext, SNOWFLAKE, err, ok, resolveChannel, resolveMember } from '../toolkit.js';
import { INVITE_SOURCE, recordBotInvite } from '../../../services/analytics/inviteService.js';

export function registerWriteServerAssetsTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  // ── WRITE_MEMBERS - Permissions rôle, vocal, invitations, emojis, stickers, webhooks, serveur ──
  if (shouldRegister('WRITE_MEMBERS')) {

    server.registerTool(
      'update_role_permissions',
      {
        description: 'Ajoute ou retire des permissions globales sur un rôle existant. Requiert WRITE_MEMBERS.',
        inputSchema: {
          role: z.string().describe('Nom ou ID du rôle à modifier'),
          allow: z.array(z.string()).default([]).describe('Permissions à ajouter (ex: ["ManageGuild","KickMembers"])'),
          deny: z.array(z.string()).default([]).describe('Permissions à retirer (ex: ["BanMembers"])'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ role, allow, deny, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const roleId = SNOWFLAKE.test(role) ? role : null;
          const discordRole = roleId
            ? guild.roles.cache.get(roleId)
            : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

          if (!discordRole) return err(`Rôle « ${role} » introuvable`);

          let bits = discordRole.permissions.bitfield;
          for (const p of allow) {
            const bit = (PermissionFlagsBits as Record<string, bigint>)[p];
            if (bit === undefined) return err(`Permission inconnue : « ${p} »`);
            bits |= bit;
          }
          for (const p of deny) {
            const bit = (PermissionFlagsBits as Record<string, bigint>)[p];
            if (bit === undefined) return err(`Permission inconnue : « ${p} »`);
            bits &= ~bit;
          }

          if (roleGrantsAdministrator(bits) && !roleGrantsAdministrator(discordRole.permissions.bitfield)) {
            const guardResult = await guardAdminGrant({
              client,
              guild,
              actorId: null,
              requestedVia: 'MCP',
              type: 'ROLE_PERMISSION_EDIT',
              permissionBits: bits,
              targetRoleId: discordRole.id,
              targetRoleName: discordRole.name,
              requestReason: `via MCP (clé: ${key_name ?? 'agent'})`,
            });
            if (guardResult.blocked) {
              await audit(key_name, 'Permissions rôle MCP - bloquées (Admin Lock)', discordRole.name, `Demande ${guardResult.requestId}`);
              return ok({
                ok: true,
                pendingApproval: true,
                requestId: guardResult.requestId,
                message: "Cette modification accorderait ADMINISTRATOR : une demande d'approbation a été envoyée.",
              });
            }
          }

          await discordRole.setPermissions(bits, reason || 'Permissions modifiées via MCP');

          const newPerms = Object.entries(PermissionFlagsBits)
            .filter(([, bit]) => discordRole.permissions.has(bit))
            .map(([name]) => name);

          await audit(key_name, 'Permissions rôle MCP', discordRole.name, `allow: [${allow}] | deny: [${deny}]`);
          return ok({ ok: true, roleId: discordRole.id, name: discordRole.name, permissions: newPerms });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Contrôle vocal ──────────────────────────────────────────────────────

    server.registerTool(
      'move_member_voice',
      {
        description: 'Déplace un membre vers un autre salon vocal. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          channel: z.string().describe('Nom ou ID du salon vocal de destination'),
          reason: z.string().optional().describe('Raison du déplacement'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, channel, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const rm = await resolveMember(guildId, member);
          if (!rm.ok) return rm.response;

          const guildMember = await guild.members.fetch(rm.userId).catch(() => null);
          if (!guildMember) return err(`Membre « ${member} » introuvable`);
          if (!guildMember.voice.channel) return err(`Le membre n'est pas connecté en vocal`);

          const chId = SNOWFLAKE.test(channel) ? channel : null;
          const targetChannel = chId
            ? guild.channels.cache.get(chId)
            : guild.channels.cache.find((c) => c.name.toLowerCase() === channel.toLowerCase() && c.isVoiceBased());

          if (!targetChannel || !targetChannel.isVoiceBased()) return err(`Salon vocal « ${channel} » introuvable`);

          await guildMember.voice.setChannel(targetChannel, reason || 'Déplacé via MCP');

          await audit(key_name, 'Déplacement vocal MCP', rm.label, `Vers #${targetChannel.name}`);
          return ok({ ok: true, userId: rm.userId, channelId: targetChannel.id, channelName: targetChannel.name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'set_member_voice_mute',
      {
        description: 'Mute ou démute un membre côté serveur en vocal. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          muted: z.boolean().describe('true pour mute, false pour démute'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, muted, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const rm = await resolveMember(guildId, member);
          if (!rm.ok) return rm.response;

          const guildMember = await guild.members.fetch(rm.userId).catch(() => null);
          if (!guildMember) return err(`Membre « ${member} » introuvable`);
          if (!guildMember.voice.channel) return err(`Le membre n'est pas connecté en vocal`);

          await guildMember.voice.setMute(muted, reason || 'Via MCP');

          await audit(key_name, muted ? 'Mute vocal MCP' : 'Démute vocal MCP', rm.label, '');
          return ok({ ok: true, userId: rm.userId, muted });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'set_member_voice_deafen',
      {
        description: 'Rend sourd ou annule la surdité serveur d\'un membre en vocal. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          deafened: z.boolean().describe('true pour deafen, false pour annuler'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, deafened, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const rm = await resolveMember(guildId, member);
          if (!rm.ok) return rm.response;

          const guildMember = await guild.members.fetch(rm.userId).catch(() => null);
          if (!guildMember) return err(`Membre « ${member} » introuvable`);
          if (!guildMember.voice.channel) return err(`Le membre n'est pas connecté en vocal`);

          await guildMember.voice.setDeaf(deafened, reason || 'Via MCP');

          await audit(key_name, deafened ? 'Deafen vocal MCP' : 'Undeafen vocal MCP', rm.label, '');
          return ok({ ok: true, userId: rm.userId, deafened });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'disconnect_member_voice',
      {
        description: 'Déconnecte un membre du salon vocal. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          reason: z.string().optional().describe('Raison de la déconnexion'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const rm = await resolveMember(guildId, member);
          if (!rm.ok) return rm.response;

          const guildMember = await guild.members.fetch(rm.userId).catch(() => null);
          if (!guildMember) return err(`Membre « ${member} » introuvable`);
          if (!guildMember.voice.channel) return err(`Le membre n'est pas connecté en vocal`);

          await guildMember.voice.disconnect(reason || 'Déconnecté via MCP');

          await audit(key_name, 'Déconnexion vocale MCP', rm.label, '');
          return ok({ ok: true, userId: rm.userId });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Invitations ─────────────────────────────────────────────────────────

    server.registerTool(
      'create_invite',
      {
        description: 'Crée un lien d\'invitation pour un salon. Requiert WRITE_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
          max_uses: z.number().int().min(0).default(0).describe('Nombre max d\'utilisations (0 = illimité)'),
          max_age: z.number().int().min(0).default(86400).describe('Durée de vie en secondes (0 = permanent, défaut 24h)'),
          temporary: z.boolean().default(false).describe('Membership temporaire (le membre est expulsé quand il se déconnecte)'),
          reason: z.string().optional().describe('Raison (pour l\'audit)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ channel, max_uses, max_age, temporary, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const chId = SNOWFLAKE.test(channel) ? channel : null;
          const mentionMatch = channel.match(MENTION_CHANNEL);
          const resolvedId = mentionMatch ? mentionMatch[1] : chId;
          const ch = resolvedId
            ? guild.channels.cache.get(resolvedId)
            : guild.channels.cache.find((c) => c.name.toLowerCase() === channel.replace(/^#/, '').toLowerCase());

          if (!ch) return err(`Salon « ${channel} » introuvable`);
          if (!('createInvite' in ch)) return err(`Le salon « ${channel} » n'accepte pas d'invitation.`);

          const invite = await ch.createInvite({
            maxUses: max_uses,
            maxAge: max_age,
            temporary,
            reason: reason || 'Créé via MCP',
          });

          await recordBotInvite(invite, INVITE_SOURCE.mcp(key_name));

          await audit(key_name, 'Création invitation MCP', `#${ch.name}`, `Code: ${invite.code}`);
          return ok({
            ok: true,
            code: invite.code,
            url: invite.url,
            channelId: ch.id,
            channelName: ch.name,
            maxUses: invite.maxUses,
            maxAge: invite.maxAge,
            temporary: invite.temporary,
            expiresAt: invite.expiresAt?.toISOString() ?? null,
          });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_invite',
      {
        description: 'Révoque une invitation active du serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          code: z.string().describe('Code de l\'invitation à révoquer'),
          reason: z.string().optional().describe('Raison de la révocation'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ code, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const invites = await guild.invites.fetch();
          const invite = invites.find((i) => i.code === code);
          if (!invite) return err(`Invitation « ${code} » introuvable ou déjà expirée`);

          await invite.delete(reason || 'Révoqué via MCP');

          await audit(key_name, 'Suppression invitation MCP', code, `Salon: ${invite.channel?.name ?? '?'}`);
          return ok({ ok: true, code });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Emojis & stickers ───────────────────────────────────────────────────

    server.registerTool(
      'create_emoji',
      {
        description: 'Crée un emoji personnalisé sur le serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().describe('Nom de l\'emoji (sans les deux-points)'),
          image_url: z.string().describe('URL de l\'image (PNG, JPG, GIF - max 256 Ko)'),
          reason: z.string().optional().describe('Raison de la création'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, image_url, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const emoji = await guild.emojis.create({ attachment: image_url, name, reason: reason || 'Créé via MCP' });

          await audit(key_name, 'Création emoji MCP', name, `ID: ${emoji.id}`);
          return ok({ ok: true, emojiId: emoji.id, name: emoji.name, url: emoji.url });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_emoji',
      {
        description: 'Renomme un emoji personnalisé. Requiert WRITE_MEMBERS.',
        inputSchema: {
          emoji: z.string().describe('Nom ou ID de l\'emoji à modifier'),
          name: z.string().describe('Nouveau nom de l\'emoji'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ emoji, name, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const emojis = await guild.emojis.fetch();
          const target = SNOWFLAKE.test(emoji)
            ? emojis.get(emoji)
            : emojis.find((e) => e.name?.toLowerCase() === emoji.toLowerCase());

          if (!target) return err(`Emoji « ${emoji} » introuvable`);

          const updated = await target.edit({ name, reason: reason || 'Modifié via MCP' });

          await audit(key_name, 'Modification emoji MCP', `${emoji} → ${name}`, `ID: ${target.id}`);
          return ok({ ok: true, emojiId: updated.id, name: updated.name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_emoji',
      {
        description: 'Supprime un emoji personnalisé du serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          emoji: z.string().describe('Nom ou ID de l\'emoji à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ emoji, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const emojis = await guild.emojis.fetch();
          const target = SNOWFLAKE.test(emoji)
            ? emojis.get(emoji)
            : emojis.find((e) => e.name?.toLowerCase() === emoji.toLowerCase());

          if (!target) return err(`Emoji « ${emoji} » introuvable`);

          const emojiName = target.name;
          await target.delete(reason || 'Supprimé via MCP');

          await audit(key_name, 'Suppression emoji MCP', emojiName ?? emoji, `ID: ${target.id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_sticker',
      {
        description: 'Crée un sticker personnalisé sur le serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().describe('Nom du sticker'),
          image_url: z.string().describe('URL de l\'image (PNG, APNG, Lottie - max 512 Ko)'),
          tags: z.string().describe('Emoji associé / tags (ex: "wave")'),
          description: z.string().optional().describe('Description du sticker'),
          reason: z.string().optional().describe('Raison de la création'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, image_url, tags, description, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const sticker = await guild.stickers.create({
            file: image_url,
            name,
            tags,
            description: description || '',
            reason: reason || 'Créé via MCP',
          });

          await audit(key_name, 'Création sticker MCP', name, `ID: ${sticker.id}`);
          return ok({ ok: true, stickerId: sticker.id, name: sticker.name, url: sticker.url });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_sticker',
      {
        description: 'Modifie un sticker personnalisé du serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          sticker: z.string().describe('Nom ou ID du sticker à modifier'),
          name: z.string().optional().describe('Nouveau nom'),
          tags: z.string().optional().describe('Nouveau tag emoji'),
          description: z.string().optional().describe('Nouvelle description'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ sticker, name, tags, description, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const stickers = await guild.stickers.fetch();
          const target = SNOWFLAKE.test(sticker)
            ? stickers.get(sticker)
            : stickers.find((s) => s.name.toLowerCase() === sticker.toLowerCase());

          if (!target) return err(`Sticker « ${sticker} » introuvable`);

          const updated = await target.edit({
            name: name ?? undefined,
            tags: tags ?? undefined,
            description: description ?? undefined,
            reason: reason || 'Modifié via MCP',
          });

          await audit(key_name, 'Modification sticker MCP', target.name, `ID: ${target.id}`);
          return ok({ ok: true, stickerId: updated.id, name: updated.name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_sticker',
      {
        description: 'Supprime un sticker personnalisé du serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          sticker: z.string().describe('Nom ou ID du sticker à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ sticker, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const stickers = await guild.stickers.fetch();
          const target = SNOWFLAKE.test(sticker)
            ? stickers.get(sticker)
            : stickers.find((s) => s.name.toLowerCase() === sticker.toLowerCase());

          if (!target) return err(`Sticker « ${sticker} » introuvable`);

          const stickerName = target.name;
          await target.delete(reason || 'Supprimé via MCP');

          await audit(key_name, 'Suppression sticker MCP', stickerName, `ID: ${target.id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_thread',
      {
        description: 'Supprime un thread. Requiert WRITE_MEMBERS.',
        inputSchema: {
          thread: z.string().describe('ID du thread à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ thread, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const threadChannel = guild.channels.cache.get(thread);
          if (!threadChannel?.isThread()) return err(`Thread « ${thread} » introuvable`);

          const threadName = threadChannel.name;
          await threadChannel.delete(reason || 'Supprimé via MCP');

          await audit(key_name, 'Suppression thread MCP', threadName, `ID: ${thread}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Webhooks ────────────────────────────────────────────────────────────

    server.registerTool(
      'create_webhook',
      {
        description: 'Crée un webhook dans un salon. Requiert WRITE_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
          name: z.string().describe('Nom du webhook'),
          reason: z.string().optional().describe('Raison de la création'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ channel, name, reason, key_name }) => {
        try {
          const resolved = resolveChannel(guildId, client, channel);
          if (!resolved.ok) return resolved.response;

          const webhook = await resolved.channel.createWebhook({ name, reason: reason || 'Créé via MCP' });

          await audit(key_name, 'Création webhook MCP', name, `ID: ${webhook.id} dans #${resolved.channel.name}`);
          return ok({ ok: true, webhookId: webhook.id, name: webhook.name, url: webhook.url, channelId: resolved.channel.id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_webhook',
      {
        description: 'Modifie un webhook existant (nom ou salon). Requiert WRITE_MEMBERS.',
        inputSchema: {
          webhook: z.string().describe('ID du webhook à modifier'),
          name: z.string().optional().describe('Nouveau nom'),
          channel: z.string().optional().describe('Nom ou ID du nouveau salon'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ webhook, name, channel, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const webhooks = await guild.fetchWebhooks();
          const target = webhooks.get(webhook);
          if (!target) return err(`Webhook « ${webhook} » introuvable`);

          const editData: { name?: string; channel?: string; reason?: string } = {};
          if (name) editData.name = name;
          if (channel) {
            const resolved = resolveChannel(guildId, client, channel);
            if (!resolved.ok) return resolved.response;
            editData.channel = resolved.channel.id;
          }

          const updated = await target.edit({ ...editData, reason: reason || 'Modifié via MCP' });

          await audit(key_name, 'Modification webhook MCP', target.name ?? webhook, `ID: ${webhook}`);
          return ok({ ok: true, webhookId: updated.id, name: updated.name, channelId: updated.channelId });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_webhook',
      {
        description: 'Supprime un webhook. Requiert WRITE_MEMBERS.',
        inputSchema: {
          webhook: z.string().describe('ID du webhook à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ webhook, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const webhooks = await guild.fetchWebhooks();
          const target = webhooks.get(webhook);
          if (!target) return err(`Webhook « ${webhook} » introuvable`);

          const webhookName = target.name;
          await target.delete(reason || 'Supprimé via MCP');

          await audit(key_name, 'Suppression webhook MCP', webhookName ?? webhook, `ID: ${webhook}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Réglages globaux du serveur ─────────────────────────────────────────

    server.registerTool(
      'update_guild_settings',
      {
        description: 'Modifie les réglages globaux du serveur Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().optional().describe('Nouveau nom du serveur'),
          icon_url: z.string().optional().describe('URL de la nouvelle icône'),
          banner_url: z.string().optional().describe('URL de la nouvelle bannière (niveau de boost requis)'),
          splash_url: z.string().optional().describe('URL du nouveau splash d\'invitation'),
          verification_level: z.enum(['0', '1', '2', '3', '4']).optional().describe('Niveau de vérification (0=Aucun, 1=Faible, 2=Moyen, 3=Élevé, 4=Très élevé)'),
          afk_channel: z.string().optional().describe('Nom ou ID du salon AFK'),
          afk_timeout: z.enum(['60', '300', '900', '1800', '3600']).optional().describe('Timeout AFK en secondes'),
          default_message_notifications: z.enum(['0', '1']).optional().describe('Notifications par défaut (0=Tous les messages, 1=Seulement les mentions)'),
          system_channel: z.string().optional().describe('Nom ou ID du salon système'),
          preferred_locale: z.string().optional().describe('Locale du serveur (ex: "fr", "en-US")'),
          description: z.string().optional().describe('Description du serveur'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, icon_url, banner_url, splash_url, verification_level, afk_channel, afk_timeout, default_message_notifications, system_channel, preferred_locale, description, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const editData: Record<string, any> = {};
          if (name !== undefined) editData.name = name;
          if (icon_url !== undefined) editData.icon = icon_url;
          if (banner_url !== undefined) editData.banner = banner_url;
          if (splash_url !== undefined) editData.splash = splash_url;
          if (verification_level !== undefined) editData.verificationLevel = parseInt(verification_level, 10);
          if (default_message_notifications !== undefined) editData.defaultMessageNotifications = parseInt(default_message_notifications, 10);
          if (preferred_locale !== undefined) editData.preferredLocale = preferred_locale;
          if (description !== undefined) editData.description = description;
          if (afk_timeout !== undefined) editData.afkTimeout = parseInt(afk_timeout, 10);

          if (afk_channel !== undefined) {
            const ch = SNOWFLAKE.test(afk_channel)
              ? guild.channels.cache.get(afk_channel)
              : guild.channels.cache.find((c) => c.name.toLowerCase() === afk_channel.toLowerCase() && c.isVoiceBased());
            if (!ch) return err(`Salon AFK « ${afk_channel} » introuvable`);
            editData.afkChannel = ch.id;
          }

          if (system_channel !== undefined) {
            const ch = SNOWFLAKE.test(system_channel)
              ? guild.channels.cache.get(system_channel)
              : guild.channels.cache.find((c) => c.name.toLowerCase() === system_channel.toLowerCase() && c.isTextBased());
            if (!ch) return err(`Salon système « ${system_channel} » introuvable`);
            editData.systemChannel = ch.id;
          }

          if (Object.keys(editData).length === 0) return err('Aucune modification spécifiée');

          await guild.edit({ ...editData, reason: reason || 'Modifié via MCP' });

          const changes = Object.keys(editData).join(', ');
          await audit(key_name, 'Réglages serveur MCP', changes, `Modifié : ${changes}`);
          return ok({ ok: true, modified: Object.keys(editData) });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 11. admin_reset_economy
    server.registerTool(
      'admin_reset_economy',
      {
        description: 'Réinitialise l\'économie du serveur. Requiert une validation staff si déclenché directement.',
        inputSchema: {
          component: z.enum(['all', 'profiles', 'items', 'config', 'guilds']).default('all'),
          approved_by_staff: z.boolean().default(false).describe('Indique si un bouton Discord a déjà approuvé cette demande'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ component, approved_by_staff, key_name }) => {
        if (!approved_by_staff) {
          return err('Action critique rejetée. Utilisez request_staff_approval pour soumettre le reset à la validation humaine du staff.');
        }

        try {
          const { adminResetGuildEconomy } = await import('../../../services/features/economyService.js');
          const { restored } = await adminResetGuildEconomy(guildId, component);

          await audit(key_name, 'Réinitialisation Économie MCP', `Reset de component: ${component}`, 'Action validée par le staff');
          const restitution = restored.players > 0
            ? ` ${restored.coins} pièces de montée de niveau ont été restituées à ${restored.players} membre(s).`
            : '';
          return ok({ ok: true, message: `L'économie (${component}) a été réinitialisée avec succès.${restitution}` });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 12. admin_adjust_coins
    server.registerTool(
      'admin_adjust_coins',
      {
        description: 'Crédite ou débite des pièces RPG à un membre.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          amount: z.number().int().describe('Nombre de pièces (positif pour ajouter, négatif pour retirer)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, amount, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          const profile = await prisma.rpgProfile.upsert({
            where: { guildId_userId: { guildId, userId: resolved.userId } },
            update: { balance: { increment: amount } },
            create: { guildId, userId: resolved.userId, balance: Math.max(0, amount) }
          });

          await audit(key_name, 'Ajustement monnaie MCP', resolved.label, `Montant: ${amount}`);
          return ok({ ok: true, userId: resolved.userId, newBalance: profile.balance });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 13. admin_adjust_xp
    server.registerTool(
      'admin_adjust_xp',
      {
        description: 'Crédite ou retire de l\'XP de leveling/progression à un membre.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          // Borné : au-delà, l'incrément déborde la colonne `Int` avant même
          // que `addXp` puisse ramener le total sous le plafond.
          amount: z.number().int().min(-MAX_XP).max(MAX_XP).describe('Montant d\'XP (positif pour ajouter, négatif pour retirer)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, amount, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          if (amount >= 0) {
            await addXp(guildId, resolved.userId, amount, client);
          } else {
            await removeXp(guildId, resolved.userId, -amount, client);
          }
          const currentLevel = await prisma.memberLevel.findUnique({
            where: { guildId_userId: { guildId, userId: resolved.userId } },
            select: { level: true, xp: true }
          });

          await audit(key_name, 'Ajustement XP MCP', resolved.label, `XP: ${amount}`);
          return ok({ ok: true, userId: resolved.userId, level: currentLevel?.level, xp: currentLevel?.xp });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 14. add_automod_regex_rule / remove_automod_regex_rule
    server.registerTool(
      'add_automod_regex_rule',
      {
        description: 'Ajoute un filtre regex ou un mot banni à l\'AutoMod.',
        inputSchema: {
          word: z.string().describe('Le mot ou le motif regex banni'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ word, key_name }) => {
        try {
          const config = await prisma.autoModConfig.findUnique({ where: { guildId } });
          const currentWords = config?.customWords || [];
          if (!currentWords.includes(word)) {
            currentWords.push(word);
            await prisma.autoModConfig.update({
              where: { guildId },
              data: { customWords: currentWords }
            });
          }

          await audit(key_name, 'AutoMod règle MCP', word, 'Règle regex ajoutée');
          return ok({ ok: true, word });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'remove_automod_regex_rule',
      {
        description: 'Retire une règle de mot banni/regex de l\'AutoMod.',
        inputSchema: {
          word: z.string().describe('La règle à retirer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ word, key_name }) => {
        try {
          const config = await prisma.autoModConfig.findUnique({ where: { guildId } });
          const currentWords = config?.customWords || [];
          const filtered = currentWords.filter(w => w !== word);
          await prisma.autoModConfig.update({
            where: { guildId },
            data: { customWords: filtered }
          });

          await audit(key_name, 'AutoMod règle MCP', word, 'Règle regex retirée');
          return ok({ ok: true, word });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }
}
