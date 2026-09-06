/**
 * « Ce salon-la tient deja ce role. »
 *
 * C'est le point d'entree par lequel un navigateur decide ou Kotbo va ecrire :
 * quel salon devient le salon de journalisation du serveur, quel role devient
 * son role staff. Un identifiant accepte ici entre dans la trace de la guilde
 * et sera repris tel quel par la pose, sans creation ni verification
 * ulterieure - c'est exactement ce qu'on lui demande, et c'est pour cela qu'il
 * n'a pas le droit de se tromper.
 *
 * Ces cas fixent les deux facons de se tromper, qui ne se valent pas. Accepter
 * ce qui ne convient pas envoie le reglement dans un salon vocal ou ouvre a
 * @everyone des salons fermes. Refuser en silence, lui, recreerait sous un
 * autre nom le salon qu'on venait de designer - le doublon meme que tout ce
 * mecanisme existe pour eviter. D'ou un refus explicite, jamais un abandon.
 */
import { describe, expect, test } from 'bun:test';
import {
  parseAdoptions,
  type AdoptableKind,
} from '../../services/core/serverTemplateService.js';

/** Un serveur imaginaire, decrit par ce que chaque identifiant y designe. */
const guild = (entries: Record<string, AdoptableKind>) => (id: string) => entries[id] ?? null;

const SERVER = guild({
  '100000000000000001': 'text',
  '100000000000000002': 'voice',
  '100000000000000003': 'category',
  '100000000000000004': 'role',
});

describe('parseAdoptions', () => {
  test('retient un salon textuel pour une ligne textuelle', () => {
    const { adopt, rejected } = parseAdoptions(
      { 'welcome.rules': '100000000000000001' },
      SERVER,
      'fr',
    );

    expect(adopt).toEqual({ 'welcome.rules': '100000000000000001' });
    expect(rejected).toEqual([]);
  });

  test('retient un role pour une ligne de role, une categorie pour une categorie', () => {
    const { adopt, rejected } = parseAdoptions(
      { 'role.staff': '100000000000000004', 'staff.category': '100000000000000003' },
      SERVER,
      'fr',
    );

    expect(adopt).toEqual({
      'role.staff': '100000000000000004',
      'staff.category': '100000000000000003',
    });
    expect(rejected).toEqual([]);
  });

  test('refuse un salon vocal pour le reglement, et le dit', () => {
    // Le cas qui coute le plus cher a laisser passer : un reglement pose dans
    // un vocal est un reglement que personne ne lit, et le serveur n'a alors
    // plus rien pour activer le mode communautaire.
    const { adopt, rejected } = parseAdoptions(
      { 'welcome.rules': '100000000000000002' },
      SERVER,
      'fr',
    );

    expect(adopt).toEqual({});
    expect(rejected).toHaveLength(1);
  });

  test('refuse un identifiant que le serveur ne porte pas', () => {
    // La page a vieilli : le salon a ete supprime entre son affichage et
    // l'envoi. Poser la maquette quand meme creerait le doublon qu'on
    // cherchait a eviter, donc on refuse plutot que d'ignorer.
    const { adopt, rejected } = parseAdoptions(
      { 'staff.log': '999999999999999999' },
      SERVER,
      'fr',
    );

    expect(adopt).toEqual({});
    expect(rejected).toHaveLength(1);
  });

  test('ignore une clef qui n appartient pas au plan', () => {
    const { adopt, rejected } = parseAdoptions(
      { 'salon.invente': '100000000000000001' },
      SERVER,
      'fr',
    );

    expect(adopt).toEqual({});
    // Ignoree et non refusee : elle ne designe aucune ligne, il n'y a donc rien
    // a signaler a l'administrateur - la page ne l'a jamais affichee.
    expect(rejected).toEqual([]);
  });

  test('ignore un module : il n ecrit rien sur Discord', () => {
    const { adopt } = parseAdoptions(
      { 'module.tickets': '100000000000000001' },
      SERVER,
      'fr',
    );

    expect(adopt).toEqual({});
  });

  test('ignore ce qui n a pas la forme d un identifiant Discord', () => {
    const { adopt } = parseAdoptions(
      {
        'staff.log': '<#100000000000000001>',
        'staff.general': '',
        'welcome.welcome': 42,
        'welcome.rules': { id: '100000000000000001' },
      },
      SERVER,
      'fr',
    );

    expect(adopt).toEqual({});
  });

  test('un corps qui n est pas un objet ne produit rien', () => {
    for (const raw of [null, undefined, 'staff.log', ['100000000000000001'], 7]) {
      expect(parseAdoptions(raw, SERVER, 'fr')).toEqual({ adopt: {}, rejected: [] });
    }
  });

  test('retient ce qui convient meme quand une autre ligne est refusee', () => {
    // Le refus est rendu a l'appelant, qui decide d'arreter ; la fonction, elle,
    // ne perd pas les lignes valides en chemin.
    const { adopt, rejected } = parseAdoptions(
      { 'staff.log': '100000000000000001', 'staff.category': '100000000000000002' },
      SERVER,
      'fr',
    );

    expect(adopt).toEqual({ 'staff.log': '100000000000000001' });
    expect(rejected).toHaveLength(1);
  });
});
