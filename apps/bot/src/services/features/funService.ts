import { Message } from 'discord.js';
import prisma from '../../utils/db.js';

/**
 * Gets or creates the Fun Game State for a guild.
 */
export async function getOrCreateFunGameState(guildId: string) {
  let state = await prisma.funGameState.findUnique({
    where: { guildId }
  });

  if (!state) {
    state = await prisma.funGameState.create({
      data: {
        guildId,
        countingCurrent: 0,
        countingLastUserId: null,
        oneWordStoryLastUserId: null,
        guessNumberTarget: Math.floor(Math.random() * 1000) + 1
      }
    });
  }

  return state;
}

/**
 * Resets the counting game.
 */
export async function resetCounting(guildId: string) {
  return prisma.funGameState.upsert({
    where: { guildId },
    create: {
      guildId,
      countingCurrent: 0,
      countingLastUserId: null,
      guessNumberTarget: Math.floor(Math.random() * 1000) + 1
    },
    update: {
      countingCurrent: 0,
      countingLastUserId: null
    }
  });
}

/**
 * Resets the guess the number game with a new target.
 */
export async function resetGuessNumber(guildId: string) {
  const newTarget = Math.floor(Math.random() * 1000) + 1;
  return prisma.funGameState.upsert({
    where: { guildId },
    create: {
      guildId,
      countingCurrent: 0,
      guessNumberTarget: newTarget
    },
    update: {
      guessNumberTarget: newTarget
    }
  });
}

/**
 * Avertit d'une erreur sans réinitialiser l'état du jeu : supprime le message
 * fautif et prévient son auteur, le temps que quelqu'un d'autre reprenne
 * correctement. Utilisé quand le mode punitif est désactivé.
 */
async function warnMistakeWithoutReset(message: Message, text: string) {
  await message.delete().catch(() => null);
  if (!message.channel.isSendable()) return;
  const warnMsg = await message.channel.send(text).catch(() => null);
  if (warnMsg) {
    setTimeout(() => {
      warnMsg.delete().catch(() => null);
    }, 4000);
  }
}

/**
 * Handles messages in the Counting channel.
 *
 * `punitiveMode` détermine ce qui arrive à une erreur : reset complet du
 * comptage (comportement historique), ou simple suppression du message avec
 * avertissement, la progression étant préservée.
 */
export async function handleCountingMessage(message: Message, guildId: string, punitiveMode: boolean) {
  const content = message.content.trim();

  // Only process if the message is exactly a number
  if (!/^\d+$/.test(content)) {
    return;
  }

  const num = parseInt(content, 10);
  const gameState = await getOrCreateFunGameState(guildId);
  const nextNumber = gameState.countingCurrent + 1;

  // Rule 1: Incorrect number resets the game
  if (num !== nextNumber) {
    if (punitiveMode) {
      await resetCounting(guildId);
      await message.react('❌').catch(() => null);
      await message.reply(`❌ **Chiffre incorrect !** ${message.author} a ruiné le comptage à **${gameState.countingCurrent}**. On recommence à 0 !`).catch(() => null);
    } else {
      await warnMistakeWithoutReset(message, `❌ ${message.author}, tu t'es trompé ! Le prochain nombre est **${nextNumber}**.`);
    }
    return;
  }

  // Rule 2: Same user cannot count twice in a row
  if (gameState.countingLastUserId === message.author.id) {
    if (punitiveMode) {
      await resetCounting(guildId);
      await message.react('❌').catch(() => null);
      await message.reply(`❌ **Double comptage !** Vous ne pouvez pas compter deux fois de suite. Le comptage est réinitialisé à 0 !`).catch(() => null);
    } else {
      await warnMistakeWithoutReset(message, `❌ ${message.author}, tu t'es trompé ! Tu ne peux pas compter deux fois de suite. Le prochain nombre reste **${nextNumber}**.`);
    }
    return;
  }

  // Correct count! Update state
  await prisma.funGameState.update({
    where: { guildId },
    data: {
      countingCurrent: nextNumber,
      countingLastUserId: message.author.id
    }
  });

  await message.react('✅').catch(() => null);

  // Celebratory milestones
  if (nextNumber % 100 === 0) {
    await message.react('🎉').catch(() => null);
    await message.react('💯').catch(() => null);
    if (!message.channel.isSendable()) {
      return;
    }
    await message.channel.send(`🎉 **Palier exceptionnel !** Nous avons atteint **${nextNumber}** ! Bravo à tous ! 👑`).catch(() => null);
  } else if (nextNumber % 10 === 0) {
    await message.react('⭐').catch(() => null);
  }
}

/**
 * Handles messages in the One Word Story channel.
 */
export async function handleOneWordStoryMessage(message: Message, guildId: string) {
  const content = message.content.trim();
  
  if (!content) return;

  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const gameState = await getOrCreateFunGameState(guildId);

  // Validate: exactly one word AND user is not the same as the last one
  const isInvalid = wordCount !== 1 || gameState.oneWordStoryLastUserId === message.author.id;

  if (isInvalid) {
    await message.delete().catch(() => null);
    if (!message.channel.isSendable()) {
      return;
    }
    const warnMsg = await message.channel.send(`❌ ${message.author}, un seul mot à la fois et vous ne pouvez pas jouer deux fois de suite !`).catch(() => null);
    if (warnMsg) {
      setTimeout(() => {
        warnMsg.delete().catch(() => null);
      }, 3000);
    }
    return;
  }

  // Valid word! Update last user
  await prisma.funGameState.update({
    where: { guildId },
    data: {
      oneWordStoryLastUserId: message.author.id
    }
  });
}

/**
 * Handles messages in the Guess the Number channel.
 */
export async function handleGuessNumberMessage(message: Message, guildId: string) {
  const content = message.content.trim();
  
  if (!/^\d+$/.test(content)) {
    return;
  }

  const guess = parseInt(content, 10);
  const gameState = await getOrCreateFunGameState(guildId);
  const target = gameState.guessNumberTarget;

  if (guess < target) {
    await message.react('⬆️').catch(() => null);
  } else if (guess > target) {
    await message.react('⬇️').catch(() => null);
  } else {
    // Winner! Generate new target
    const newTarget = Math.floor(Math.random() * 1000) + 1;
    await prisma.funGameState.update({
      where: { guildId },
      data: {
        guessNumberTarget: newTarget
      }
    });

    await message.react('🎉').catch(() => null);
    await message.reply(`🎉 **Félicitations ${message.author} !** Tu as deviné le nombre mystère qui était **${target}** ! Un nouveau nombre mystère a été généré (entre 1 et 1000).`).catch(() => null);
  }
}

const WORD_CHAIN_WORD_PATTERN = /^[a-zA-ZÀ-ÖØ-öø-ÿ-]{2,}$/;

function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Resets the word chain game.
 */
export async function resetWordChain(guildId: string) {
  return prisma.funGameState.upsert({
    where: { guildId },
    create: {
      guildId,
      guessNumberTarget: Math.floor(Math.random() * 1000) + 1,
      wordChainLastWord: null,
      wordChainLastUserId: null
    },
    update: {
      wordChainLastWord: null,
      wordChainLastUserId: null
    }
  });
}

/**
 * Handles messages in the Word Chain channel : chaque mot doit commencer par
 * la dernière lettre du précédent, posé par quelqu'un d'autre.
 *
 * `punitiveMode` détermine ce qui arrive à une erreur, comme pour le comptage.
 */
export async function handleWordChainMessage(message: Message, guildId: string, punitiveMode: boolean) {
  const content = message.content.trim();

  // Seuls les messages d'un seul mot alphabétique participent au jeu - le
  // reste (discussion) est laissé tranquille, comme pour le comptage.
  if (!WORD_CHAIN_WORD_PATTERN.test(content)) {
    return;
  }

  const gameState = await getOrCreateFunGameState(guildId);
  const normalized = stripAccents(content).toLowerCase();
  const lastWord = gameState.wordChainLastWord ? stripAccents(gameState.wordChainLastWord).toLowerCase() : null;
  const requiredLetter = lastWord ? lastWord[lastWord.length - 1] : null;

  const sameUserTwice = gameState.wordChainLastUserId === message.author.id;
  const wrongLetter = requiredLetter !== null && normalized[0] !== requiredLetter;

  if (sameUserTwice || wrongLetter) {
    if (punitiveMode) {
      await resetWordChain(guildId);
      await message.react('❌').catch(() => null);
      const reason = sameUserTwice
        ? 'vous ne pouvez pas jouer deux fois de suite'
        : `le mot devait commencer par « ${requiredLetter?.toUpperCase()} »`;
      await message.reply(`❌ **Chaîne brisée !** ${message.author}, ${reason}. On recommence !`).catch(() => null);
    } else {
      const reason = sameUserTwice
        ? 'tu ne peux pas jouer deux fois de suite'
        : `le mot devait commencer par « ${requiredLetter?.toUpperCase()} »`;
      await warnMistakeWithoutReset(message, `❌ ${message.author}, tu t'es trompé ! ${reason}.`);
    }
    return;
  }

  await prisma.funGameState.update({
    where: { guildId },
    data: {
      wordChainLastWord: content,
      wordChainLastUserId: message.author.id
    }
  });

  await message.react('✅').catch(() => null);
}

/**
 * Rébus emoji -> réponse(s) acceptée(s). Curatés à la main : pas besoin de
 * saisie côté staff, le jeu se relance seul comme le nombre mystère.
 */
const EMOJI_RIDDLES: { emojis: string; answers: string[] }[] = [
  { emojis: '🦁👑', answers: ['le roi lion', 'roi lion'] },
  { emojis: '🕷️👨', answers: ['spider-man', 'spiderman'] },
  { emojis: '🧊👸❄️', answers: ['la reine des neiges', 'reine des neiges', 'frozen'] },
  { emojis: '🦇👨', answers: ['batman'] },
  { emojis: '🍫🏭', answers: ['charlie et la chocolaterie'] },
  { emojis: '👽📞🏠', answers: ['et', 'e.t.'] },
  { emojis: '🧙‍♂️💍', answers: ['le seigneur des anneaux', 'seigneur des anneaux'] },
  { emojis: '🐉🎂', answers: ['shrek'] },
  { emojis: '🚢🧊💔', answers: ['titanic'] },
  { emojis: '👨‍🚀🌾🥔', answers: ['seul sur mars'] },
  { emojis: '🐟🔍', answers: ['le monde de nemo', 'nemo'] },
  { emojis: '🦖🏝️', answers: ['jurassic park'] },
];

function normalizeAnswer(value: string): string {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickEmojiRiddle(): { emojis: string; answers: string[] } {
  return EMOJI_RIDDLES[Math.floor(Math.random() * EMOJI_RIDDLES.length)];
}

/**
 * Génère un nouveau rébus emoji.
 */
export async function resetEmojiRiddle(guildId: string) {
  const riddle = pickEmojiRiddle();
  return prisma.funGameState.upsert({
    where: { guildId },
    create: {
      guildId,
      guessNumberTarget: Math.floor(Math.random() * 1000) + 1,
      emojiRiddleEmojis: riddle.emojis,
      emojiRiddleAnswer: JSON.stringify(riddle.answers)
    },
    update: {
      emojiRiddleEmojis: riddle.emojis,
      emojiRiddleAnswer: JSON.stringify(riddle.answers)
    }
  });
}

/**
 * Handles messages in the Emoji Riddle channel. Sans pénalité en cas
 * d'erreur : on laisse le salon deviner librement, comme pour le nombre
 * mystère.
 */
export async function handleEmojiRiddleMessage(message: Message, guildId: string) {
  const content = message.content.trim();
  if (!content) return;

  let gameState = await getOrCreateFunGameState(guildId);
  if (!gameState.emojiRiddleEmojis || !gameState.emojiRiddleAnswer) {
    gameState = await resetEmojiRiddle(guildId);
  }

  let answers: string[];
  try {
    answers = JSON.parse(gameState.emojiRiddleAnswer ?? '[]');
  } catch {
    answers = [];
  }
  if (answers.length === 0) return;

  const guess = normalizeAnswer(content);
  const isCorrect = answers.some((a) => normalizeAnswer(a) === guess);
  if (!isCorrect) return;

  const previousClue = gameState.emojiRiddleEmojis;
  await resetEmojiRiddle(guildId);
  await message.react('🎉').catch(() => null);
  await message.reply(`🎉 **Bravo ${message.author} !** Le rébus ${previousClue} voulait dire **${answers[0]}** ! Un nouveau rébus a été généré.`).catch(() => null);
}

const NEVER_SAY_PATTERN = /\b(oui|non)\b/i;

/**
 * Handles messages in the Never Say Yes/No channel : tout message contenant
 * « oui » ou « non » est supprimé, sans état à conserver.
 */
export async function handleNeverSayMessage(message: Message) {
  if (!NEVER_SAY_PATTERN.test(message.content)) return;

  await message.delete().catch(() => null);
  if (!message.channel.isSendable()) return;
  const warnMsg = await message.channel.send(`❌ ${message.author}, interdit de dire « oui » ou « non » ici !`).catch(() => null);
  if (warnMsg) {
    setTimeout(() => {
      warnMsg.delete().catch(() => null);
    }, 3000);
  }
}

const EMOJI_ONLY_PATTERN = /^(?:\p{Extended_Pictographic}|\u200D|\uFE0F|\s)+$/u;
const HAS_EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

/**
 * Handles messages in the Emoji Only channel : tout message contenant autre
 * chose que des emojis est supprimé.
 */
export async function handleEmojiOnlyMessage(message: Message) {
  const content = message.content;
  if (!content.trim()) return; // messages sans texte (pièces jointes...) laissés tranquilles

  if (EMOJI_ONLY_PATTERN.test(content) && HAS_EMOJI_PATTERN.test(content)) return;

  await message.delete().catch(() => null);
  if (!message.channel.isSendable()) return;
  const warnMsg = await message.channel.send(`❌ ${message.author}, seuls les emojis sont autorisés ici !`).catch(() => null);
  if (warnMsg) {
    setTimeout(() => {
      warnMsg.delete().catch(() => null);
    }, 3000);
  }
}
