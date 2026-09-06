# Registre synthétique des traitements

| Traitement | Rôle de Kotbo | Personnes et données | Base / instruction | Destinataires |
|---|---|---|---|---|
| Compte dashboard | Responsable | Administrateurs : identifiant, nom, avatar, serveurs accessibles, session | Exécution du service et sécurité | Équipe Kotbo, Discord, hébergeurs |
| Gestion communautaire | Sous-traitant | Membres : profil Discord, activité, rôles, participation | Instruction du responsable via les modules activés | Staff autorisé du serveur |
| Modération et comptes liés | Sous-traitant | Membres et modérateurs : sanctions, motifs, preuves, associations | Instruction du serveur, généralement intérêt légitime du responsable | Modérateurs autorisés |
| Staff et candidatures | Sous-traitant | Candidats et staff : réponses, notes, absences, réunions, évaluations | Instruction du serveur | Responsables staff autorisés |
| Tickets et formulaires | Sous-traitant | Demandeurs : contenu, pièces jointes, transcript, réponses | Instruction du serveur | Staff chargé du dossier |
| Sécurité et erreurs | Responsable | Utilisateurs : IP de vérification, événements de sécurité, erreurs et contexte | Intérêt légitime à sécuriser et maintenir le service | Équipe Kotbo, Cloudflare, Sentry si activé |
| Statistiques techniques globales | Responsable | Compteurs agrégés de modules et performances | Intérêt légitime à piloter le service | Équipe Kotbo |
| Mesure d'audience et tunnel d'acquisition | Responsable | Visiteurs et admins : identifiant session éphémère (visitorId), HMAC d'acteur, canal de provenance | Intérêt légitime & exemption CNIL (sans traceur publicitaire, durée brève, opt-out direct) | Équipe Kotbo |
| Facturation et commandes | Responsable | Acheteurs : identifiant client Stripe, factures, consentement horodaté | Exécution du contrat (art. 6-1-b) & obligations comptables (L123-22 C. com.) | Équipe Kotbo, Stripe |

Pour chaque serveur, l'administrateur complète ce registre avec ses finalités exactes, bases légales, destinataires et durées. La politique publique et le DPA constituent les références externes.
