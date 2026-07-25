import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { COLORS_RAW } from '../../utils/embeds.js';
import { runSecurityAudit, type AuditFinding } from '../../services/moderation/securityAuditService.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c1_audit');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const SEVERITY_ICONS: Record<string, string> = {
  CRITICAL: '🔴',
  WARNING: '🟠',
  INFO: '🔵',
  OK: '🟢',
};

function scoreColor(score: number): number {
  if (score >= 80) return COLORS_RAW.success;
  if (score >= 50) return COLORS_RAW.warning;
  return COLORS_RAW.danger;
}

function scoreLabel(score: number, locale: 'fr' | 'en'): string {
  if (score >= 90) return m.c1_audit_score_excellent({}, { locale });
  if (score >= 80) return m.c1_audit_score_good({}, { locale });
  if (score >= 60) return m.c1_audit_score_average({}, { locale });
  if (score >= 40) return m.c1_audit_score_weak({}, { locale });
  return m.c1_audit_score_critical({}, { locale });
}

function formatFinding(finding: AuditFinding): string {
  const icon = SEVERITY_ICONS[finding.severity] ?? '•';
  let line = `${icon} **${finding.title}**\n${finding.detail}`;
  if (finding.recommendation) line += `\n> 💡 ${finding.recommendation}`;
  return line;
}

async function execute(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) return;
  const locale = await getEffectiveLocale(interaction);

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const { score, findings } = await runSecurityAudit(guild);

  const problems = findings.filter((f) => f.severity !== 'OK');
  const oks = findings.filter((f) => f.severity === 'OK');

  const embed = new EmbedBuilder()
    .setColor(scoreColor(score))
    .setTitle(`🔍 ${m.c1_audit_title({}, { locale })}`)
    .setDescription(`## ${m.c1_audit_score_heading({ score }, { locale })} — ${scoreLabel(score, locale)}\n${score >= 80 ? m.c1_audit_protected({}, { locale }) : m.c1_audit_improvements({}, { locale })}`)
    .setTimestamp();

  if (problems.length > 0) {
    // Discord limite un field à 1024 caractères : on regroupe par blocs
    let block = '';
    let blockIndex = 0;
    for (const finding of problems) {
      const entry = formatFinding(finding);
      if (block.length + entry.length + 2 > 1024) {
        embed.addFields({ name: blockIndex === 0 ? `⚠️ ${m.c1_audit_fix_points({}, { locale })}` : '​', value: block });
        block = '';
        blockIndex++;
      }
      block += (block ? '\n\n' : '') + entry;
    }
    if (block) embed.addFields({ name: blockIndex === 0 ? `⚠️ ${m.c1_audit_fix_points({}, { locale })}` : '​', value: block });
  }

  if (oks.length > 0) {
    embed.addFields({
      name: `✅ ${m.c1_audit_compliant_points({}, { locale })}`,
      value: oks.map((f) => `🟢 ${f.title}`).join(' · ').slice(0, 1024),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

export const auditCommand: SlashCommandDefinition = { data, execute };
