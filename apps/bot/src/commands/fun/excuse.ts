import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import prisma from '../../utils/db.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('excuse')
  .setDescription('😅 Génère une excuse de développeur aléatoire')
  .addStringOption((option) =>
    option
      .setName('catégorie')
      .setDescription("Catégorie de l'excuse (optionnel)")
      .setRequired(false)
      .addChoices(
        { name: '🎯 Les classiques incontournables', value: 'classiques' },
        { name: '🔀 Git, CI/CD & Révisions', value: 'git_cicd' },
        { name: '☁️ Infrastructure, Docker & Cloud', value: 'infra_cloud' },
        { name: '🎨 Front-end, CSS & Browsers', value: 'frontend' },
        { name: '⚙️ Back-end, APIs & Data', value: 'backend' },
        { name: '📦 Enfer des dépendances & Runtimes', value: 'dependencies' },
        { name: '📋 Gestion de projet & Spécifications', value: 'management' },
        { name: "🤖 L'ère de l'IA & Génération de code", value: 'ai' },
        { name: '💻 Physique, Réseau & Hardware', value: 'hardware' },
        { name: '🃏 Mauvaise foi pure & Facteur humain', value: 'bad_faith' },
      ),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const category = interaction.options.getString('catégorie');
  const locale = await getEffectiveLocale(interaction);

  const whereClause: { language: string; category?: string } = { language: 'fr' };
  if (category) {
    whereClause.category = category;
  }

  const excuses = await prisma.developerExcuse.findMany({
    where: whereClause,
    select: { text: true },
  });

  if (excuses.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_excuse_none_title({}, { locale }), category ? m.b2_excuse_none_category({ category }, { locale }) : m.b2_excuse_none_desc({}, { locale }))],
    });
    return;
  }

  const randomExcuse = excuses[Math.floor(Math.random() * excuses.length)]?.text ?? m.b2_excuse_not_found({}, { locale });

  await interaction.reply({
    embeds: [
      successEmbed(m.b2_excuse_found_title({}, { locale }), `> ${randomExcuse}`),
    ],
  });
}

export const excuseCommand = { data, execute } satisfies SlashCommandDefinition;
