/**
 * Reconnaissance des bots deja presents sur un serveur.
 *
 * La correspondance etait une egalite stricte sur le nom en minuscules. Elle
 * tenait tant que les bots s'appelaient « probot » ; ils s'appellent
 * « ProBot ✨ ». Un bot pourtant inscrit au registre s'affichait alors « non
 * reconnu », et la reprise passait a cote de ce qu'il y avait a reprendre.
 *
 * Ces cas fixent surtout ce qui doit continuer de matcher malgre la decoration.
 */
import { describe, expect, test } from 'bun:test';
import { KNOWN_BOTS, matchKnownBot } from '../../services/core/botRegistry.js';

describe('matchKnownBot', () => {
  test('reconnait un nom nu', () => {
    expect(matchKnownBot('mee6')?.key).toBe('mee6');
    expect(matchKnownBot('probot')?.key).toBe('probot');
  });

  test('la casse et les espaces autour ne comptent pas', () => {
    expect(matchKnownBot('  MEE6 ')?.key).toBe('mee6');
    expect(matchKnownBot('DraftBot')?.key).toBe('draftbot');
  });

  test('un emoji dans le nom ne rend plus le bot invisible', () => {
    // Le cas qui a motive le correctif : lu tel quel sur un serveur reel.
    expect(matchKnownBot('ProBot ✨')?.key).toBe('probot');
    expect(matchKnownBot('Wick ⚡')?.key).toBe('wick');
  });

  test('les decorations de nom sont ignorees', () => {
    // « | Support », les tirets, les points : de la ponctuation, pas un nom.
    expect(matchKnownBot('Ticket Tool | Support')?.key).toBe('ticket-tool');
    expect(matchKnownBot('Carl-bot')?.key).toBe('carlbot');
    expect(matchKnownBot('YAGPDB.xyz')?.key).toBe('yagpdb');
  });

  test('les accents sont replies', () => {
    expect(matchKnownBot('RàidProtect')?.key).toBe('raidprotect');
  });

  test('un nom en deux mots se retrouve aussi colle, et inversement', () => {
    // Le registre ecrit « invite tracker » ; le serveur peut porter les deux.
    expect(matchKnownBot('invitetracker')?.key).toBe('invite-tracker');
    expect(matchKnownBot('Invite Tracker')?.key).toBe('invite-tracker');
    // Le registre ecrit « draftbot » ; l'espace ne doit pas casser.
    expect(matchKnownBot('Draft Bot')?.key).toBe('draftbot');
  });

  test('un bot inconnu reste inconnu', () => {
    // Un bot maison ne doit surtout pas etre rapproche de force d'une fiche
    // voisine : « non reconnu » est une reponse honnete, une fausse
    // correspondance ferait reprendre des reglages qui n'ont rien a voir.
    expect(matchKnownBot('La Taverne du Survivant')).toBeNull();
    expect(matchKnownBot('')).toBeNull();
    expect(matchKnownBot('✨')).toBeNull();
  });

  test('les bots sans recoupement sont inscrits, avec un `covers` vide', () => {
    // C'est ce qui distingue « rien a reprendre » de « non reconnu » dans la
    // page : DISBOARD est connu, il n'y a simplement rien a en tirer.
    const disboard = matchKnownBot('DISBOARD');
    expect(disboard).not.toBeNull();
    expect(disboard!.covers).toEqual([]);
  });

  test('reconnait les bots de communauté, d animation et serveurs', () => {
    expect(matchKnownBot('ASCEND')?.key).toBe('ascend');
    expect(matchKnownBot('BotRix')?.key).toBe('botrix');
    expect(matchKnownBot("Bouns'Bot")?.key).toBe('bounsbot');
    expect(matchKnownBot('counting')?.key).toBe('counting');
    expect(matchKnownBot('countingclassic')?.key).toBe('countingclassic');
    expect(matchKnownBot('DFR')?.key).toBe('dfr');
    expect(matchKnownBot('French.gg')?.key).toBe('french-gg');
    expect(matchKnownBot('GiveawayBot')?.key).toBe('giveawaybot');
    expect(matchKnownBot('Kotbo')?.key).toBe('kotbo');
    expect(matchKnownBot('Koya')?.key).toBe('koya');
    expect(matchKnownBot('La Date du Jour')?.key).toBe('date-du-jour');
    expect(matchKnownBot('MineStaaR')?.key).toBe('minestaar');
    expect(matchKnownBot('Mudae')?.key).toBe('mudae');
    expect(matchKnownBot('Reaction Roles')?.key).toBe('reaction-roles');
    expect(matchKnownBot('StaaRBot')?.key).toBe('staarbot');
    expect(matchKnownBot('StaaRCraft')?.key).toBe('staarcraft');
    expect(matchKnownBot('Streamcord')?.key).toBe('streamcord');
    expect(matchKnownBot('TempVoice')?.key).toBe('tempvoice');
    expect(matchKnownBot('Test LSA')?.key).toBe('test-lsa');
    expect(matchKnownBot('VoiceMaster')?.key).toBe('voicemaster');
    expect(matchKnownBot('Would You')?.key).toBe('wouldyou');
  });
});

describe('registre', () => {
  test('aucune cle en double', () => {
    const keys = KNOWN_BOTS.map((bot) => bot.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('aucun nom d utilisateur revendique par deux fiches', () => {
    // Deux fiches sur le meme nom, c'est un bot qui bascule de l'une a l'autre
    // au gre de l'ordre du tableau - le genre d'incoherence qu'on ne remarque
    // qu'en production.
    const seen = new Map<string, string>();
    for (const bot of KNOWN_BOTS) {
      for (const username of bot.usernames) {
        const normalized = username.toLowerCase().replace(/[^a-z0-9]+/g, '');
        const previous = seen.get(normalized);
        expect(previous ?? bot.key).toBe(bot.key);
        seen.set(normalized, bot.key);
      }
    }
  });

  test('chaque fiche porte au moins un nom d utilisateur', () => {
    for (const bot of KNOWN_BOTS) {
      expect(bot.usernames.length).toBeGreaterThan(0);
    }
  });
});
