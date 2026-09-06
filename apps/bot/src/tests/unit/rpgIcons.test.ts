import { describe, expect, test } from 'bun:test';
import { combatHpBar, gaugeBar, icon, itemTypeIcon, rarityIcon, RPG_COLORS } from '../../services/features/rpg/rpgIcons.js';
import { UNICODE_FALLBACKS } from '../../utils/emojis.js';

describe('icon', () => {
  test('rend un emoji utilisable pour toutes les clés du module RPG', () => {
    // `setEmoji('')` fait rejeter le message entier par Discord : une clé du hub
    // qui ne résout rien casserait l'écran, pas seulement son bouton.
    const keys = [
      'rpgSword', 'rpgArmor', 'rpgAccessory', 'rpgPotion', 'rpgKey',
      'rpgBag', 'rpgShop', 'rpgFight', 'rpgBoss', 'rpgTravel', 'rpgCharacter',
      'rpgCraft', 'rpgForge', 'rpgEnchant', 'rpgBestiary', 'rpgGuild', 'rpgWar',
      'rpgClan', 'rpgDaily', 'rpgFish', 'rpgBlackMarket', 'rpgRaid', 'rpgPay',
      'rpgSell', 'rpgHp', 'rpgEnergy', 'rpgXp', 'rpgAtk', 'rpgDef', 'rpgSpd',
      'rpgCrit', 'rpgRest', 'rpgBack', 'rpgPrev', 'rpgNext', 'rpgRefresh',
      'rpgBarHpL', 'rpgBarHpM', 'rpgBarHpR',
      'rpgBarEnL', 'rpgBarEnM', 'rpgBarEnR',
      'rpgBarXpL', 'rpgBarXpM', 'rpgBarXpR',
    ];

    for (const key of keys) {
      expect(icon(key)).not.toBe('');
      expect(UNICODE_FALLBACKS[key]).toBeTruthy();
    }
  });

  test('retombe sur un glyphe visible pour une clé inconnue', () => {
    expect(icon('cleQuiNExistePas')).toBe('•');
  });
});

describe('rarityIcon', () => {
  test('donne une icône distincte à chaque rareté connue', () => {
    const rarities = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'];
    const icons = rarities.map(rarityIcon);

    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(rarities.length);
  });

  test('ne rend rien pour une rareté absente ou inconnue', () => {
    // La rareté vient de la base : un objet créé au dashboard peut en porter une
    // qui n'existe plus. La ligne doit rester lisible, sans glyphe parasite.
    expect(rarityIcon(null)).toBe('');
    expect(rarityIcon(undefined)).toBe('');
    expect(rarityIcon('MYTHIQUE')).toBe('');
  });
});

describe('itemTypeIcon', () => {
  test('donne une icône distincte à chaque catégorie de la boutique', () => {
    const types = ['WEAPON', 'ARMOR', 'ACCESSORY', 'POTION', 'QUEST'];
    const icons = types.map(itemTypeIcon);

    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(types.length);
  });

  test('retombe sur le sac pour un type inconnu', () => {
    expect(itemTypeIcon('AUTRE')).toBe(icon('rpgBag'));
    expect(itemTypeIcon(null)).toBe(icon('rpgBag'));
  });
});

describe('gaugeBar', () => {
  test('compose dix segments et le pourcentage', () => {
    const full = gaugeBar(100, 100, 'hp');
    expect(full).toEndWith('(100%)');
    expect(full.startsWith(icon('rpgBarHpL'))).toBe(true);
    expect(full).toContain(icon('rpgBarHpR'));

    const empty = gaugeBar(0, 100, 'en');
    expect(empty).toEndWith('(0%)');
    expect(empty.startsWith(icon('barEmptyL'))).toBe(true);
  });

  test('n’allume un segment qu’une fois le dixième réellement franchi', () => {
    // Un arrondi au plus proche montrerait une jauge pleine à 96 % et un
    // segment allumé à 4 % : sur dix crans, cela ment sur l'état réel.
    expect(gaugeBar(96, 100, 'xp')).toContain(icon('barEmptyR'));
    expect(gaugeBar(4, 100, 'xp')).not.toContain(icon('rpgBarXpL'));
    expect(gaugeBar(10, 100, 'xp')).toContain(icon('rpgBarXpL'));
  });

  test('borne les valeurs aberrantes au lieu de produire une barre difforme', () => {
    // Les PV peuvent dépasser le maximum le temps qu'un bonus d'équipement
    // saute, et un maximum à zéro existe sur une fiche jamais initialisée.
    expect(gaugeBar(150, 100, 'hp')).toEndWith('(100%)');
    expect(gaugeBar(-20, 100, 'hp')).toEndWith('(0%)');
    expect(gaugeBar(5, 0, 'hp')).toEndWith('(100%)');
  });
});

describe('combatHpBar', () => {
  test('chiffre les points de vie au lieu du pourcentage', () => {
    expect(combatHpBar(42, 120)).toContain('`42/120 PV`');
    expect(combatHpBar(42, 120)).not.toContain('%');
  });

  test('n’affiche jamais de points de vie négatifs', () => {
    // Un coup fatal laisse un total négatif : la fiche de défaite doit
    // afficher zéro, pas « -12/120 ».
    expect(combatHpBar(-12, 120)).toContain('`0/120 PV`');
  });
});

describe('RPG_COLORS', () => {
  test('ne reprend pas le blurple générique du bot', () => {
    // Le module se distinguait en rien du reste du bot : chaque écran portait
    // exactement la même tranche que la modération ou les tickets.
    expect(Object.values(RPG_COLORS)).not.toContain(0x5865f2);
    for (const value of Object.values(RPG_COLORS)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffff);
    }
  });
});
