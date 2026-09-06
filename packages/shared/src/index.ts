/**
 * Logique pure partagée entre le bot et le dashboard.
 *
 * Ce package ne dépend de rien : ni Prisma, ni discord.js, ni API navigateur.
 * Il accueille les algorithmes utilisés des deux côtés, que le bot peut tester
 * et que le dashboard peut embarquer dans son bundle.
 */
export * from './textDiff.js';
export * from './workflow/types.js';
export * from './workflow/cron.js';
export * from './workflow/catalog.js';
export * from './workflow/layout.js';
export * from './workflow/validate.js';
export * from './workflow/recipe.js';
export * from './workflow/recipeTemplates.js';
export * from './workflow/library.js';
export * from './workflow/compile.js';
export * from './workflow/decompile.js';
export * from './simulation/types.js';
export * from './leveling/curve.js';
export * from './leveling/clanPoints.js';
export * from './clans/bets.js';
export * from './drops/policy.js';
export * from './leveling/dailyCap.js';
export * from './ranked/ladder.js';
export * from './ranked/ladderCurve.js';
export * from './ranked/presets.js';
export * from './ranked/streaks.js';
export * from './ranked/decay.js';
export * from './ranked/gains.js';
export * from './rankCard/types.js';
export * from './rankCard/presets.js';
export * from './rankCard/fonts.js';
export * from './rankCard/normalize.js';
export * from './automod/presets.js';
