import { Client, AttachmentBuilder, GuildMember } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import prisma from '../../utils/db.js';
import { canvasFont, ensureCanvasFonts } from '../../utils/canvasFonts.js';
import { logger } from '../../utils/logger.js';
import { resolvePlaceholders } from '../../utils/placeholders.js';

/**
 * Récupère ou initialise la configuration d'accueil d'une guilde
 */
export async function getOrCreateWelcomeConfig(guildId: string) {
  let config = await prisma.welcomeConfig.findUnique({
    where: { guildId },
  });

  if (!config) {
    config = await prisma.welcomeConfig.create({
      data: {
        guildId,
        welcomeEnabled: false,
        welcomeMessage: "Bienvenue {user} sur notre serveur ! 🎉",
        welcomeImageEnabled: false,
        leaveEnabled: false,
        leaveMessage: "Au revoir {user}... 😢",
        boostEnabled: false,
        boostMessage: "Merci pour ton boost {user} ! 🚀",
        boostImageEnabled: false,
        tagAutoRoleEnabled: false,
        tagAutoRoleWord: "",
      },
    });
  }
  return config;
}

function replaceTokens(template: string, member: GuildMember): string {
  return resolvePlaceholders(template, {
    guild: member.guild,
    member,
  });
}

/**
 * Gère l'arrivée d'un membre (Welcome)
 */
export async function handleGuildMemberAdd(member: GuildMember, _client: Client) {
  try {
    const config = await getOrCreateWelcomeConfig(member.guild.id);
    if (!config.welcomeEnabled || !config.welcomeChannelId) return;

    const channel = member.guild.channels.cache.get(config.welcomeChannelId);
    if (!channel?.isTextBased()) return;

    const text = replaceTokens(config.welcomeMessage, member);
    const options: { content: string; files?: AttachmentBuilder[] } = { content: text };

    // Si la bannière image est activée, la générer
    if (config.welcomeImageEnabled) {
      const buffer = await generateWelcomeCard(member);
      const attachment = new AttachmentBuilder(buffer, { name: 'welcome-card.png' });
      options.files = [attachment];
    }

    await channel.send(options).catch(() => null);
  } catch (err) {
    logger.error('WelcomeGoodbyeService', `Erreur lors de l'arrivée du membre ${member.id}:`, err);
  }
}

/**
 * Gère le départ d'un membre (Leave)
 */
export async function handleGuildMemberRemove(member: GuildMember, _client: Client) {
  try {
    const config = await getOrCreateWelcomeConfig(member.guild.id);
    if (!config.leaveEnabled || !config.leaveChannelId) return;

    const channel = member.guild.channels.cache.get(config.leaveChannelId);
    if (!channel?.isTextBased()) return;

    const text = replaceTokens(config.leaveMessage, member);
    await channel.send({ content: text }).catch(() => null);
  } catch (err) {
    logger.error('WelcomeGoodbyeService', `Erreur lors du départ du membre ${member.id}:`, err);
  }
}

/**
 * Gère le boost d'un membre (Boost)
 */
export async function handleGuildBoost(newMember: GuildMember, _client: Client) {
  try {
    const config = await getOrCreateWelcomeConfig(newMember.guild.id);
    if (!config.boostEnabled || !config.boostChannelId) return;

    const channel = newMember.guild.channels.cache.get(config.boostChannelId);
    if (!channel?.isTextBased()) return;

    const text = replaceTokens(config.boostMessage, newMember);
    const options: { content: string; files?: AttachmentBuilder[] } = { content: text };

    if (config.boostImageEnabled) {
      const buffer = await generateWelcomeCard(newMember, 'MERCI !');
      const attachment = new AttachmentBuilder(buffer, { name: 'boost-card.png' });
      options.files = [attachment];
    }

    await channel.send(options).catch(() => null);
  } catch (err) {
    logger.error('WelcomeGoodbyeService', `Erreur lors du boost du membre ${newMember.id}:`, err);
  }
}

/**
 * Attribue le rôle automatique d'arrivée si configuré
 */
export async function applyJoinAutoRole(member: GuildMember) {
  try {
    const config = await getOrCreateWelcomeConfig(member.guild.id);
    if (!config.joinRoleId) return;

    const role = member.guild.roles.cache.get(config.joinRoleId);
    if (!role) return;

    if (!member.roles.cache.has(config.joinRoleId)) {
      await member.roles.add(role, "Auto-rôle à l'arrivée").catch(() => null);
    }
  } catch (err) {
    logger.error('WelcomeGoodbyeService', `Erreur auto-rôle join pour ${member.id}:`, err);
  }
}

/**
 * Génère une carte de bienvenue au format PNG avec Canvas
 */
export async function generateWelcomeCard(member: GuildMember, titleText = 'BIENVENUE !'): Promise<Buffer> {
  ensureCanvasFonts();

  const W = 800, H = 300;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Arrière-plan dégradé bleu/violet sombre
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0b0e14');
  bg.addColorStop(1, '#161a29');
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, W, H, 16, bg);

  // Bordure brillante discrète
  ctx.strokeStyle = 'rgba(88, 101, 242, 0.3)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // Halo lumineux radial
  const glow = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 350);
  glow.addColorStop(0, 'rgba(88, 101, 242, 0.15)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Avatar circulaire centré en haut
  const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 128 });
  try {
    const avatarImg = await loadImage(avatarUrl);
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, 85, 55, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatarImg, W / 2 - 55, 30, 110, 110);
    ctx.restore();
  } catch (e) {
    ctx.fillStyle = '#5865f2';
    ctx.beginPath();
    ctx.arc(W / 2, 85, 55, 0, Math.PI * 2);
    ctx.fill();
  }

  // Double cercle de bordure de l'avatar
  ctx.strokeStyle = '#5865f2';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(W / 2, 85, 56, 0, Math.PI * 2);
  ctx.stroke();

  // Textes de bienvenue
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = canvasFont(36, 'bold');
  ctx.fillText(titleText, W / 2, 195);

  ctx.fillStyle = '#57f287';
  ctx.font = canvasFont(24, 'bold');
  ctx.fillText(member.user.username.toUpperCase(), W / 2, 230);

  ctx.fillStyle = '#b8bcc8';
  ctx.font = canvasFont(14);
  ctx.fillText(`Membre #${member.guild.memberCount} sur ${member.guild.name.toUpperCase()}`, W / 2, 265);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}

// Helper rectangle arrondi
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
