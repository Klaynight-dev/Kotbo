# Mesure d'audience et tunnel d'acquisition — Cadre de conformité RGPD & CNIL

Ce document détaille l'architecture juridique et technique de la mesure d'audience
et du suivi du tunnel d'acquisition mis en place sur Kotbo et le site vitrine kotbo.fr.

---

## 1. Régime retenu : Exemption de consentement préalable (CNIL)

La mesure d'audience de Kotbo est conçue pour respecter strictement les critères
d'exemption de consentement fixés par la délibération CNIL n° 2020-091 :

1. **Finalité exclusive** : La mesure sert uniquement à produire des statistiques
   anonymes de fréquentation, d'ergonomie et de conversion (mesure des sections
   consultées, identification des points de blocage du tunnel, canaux d'arrivée).
   Aucune donnée n'est utilisée à des fins publicitaires, de reciblage ou de profilage.
2. **Pas de suivi inter-sites** : L'identifiant de visite (`visitorId`) ne permet
   aucun pistage en dehors du domaine `kotbo.fr`.
3. **Absence de transmission à des tiers** : Aucun script ou traceur tiers (type
   Google Analytics ou Facebook Pixel) n'est injecté. Toutes les requêtes sont
   traitées directement par l'API First-Party de Kotbo.
4. **Pas de stockage persistant sans consentement** : L'identifiant de visite est
   généré aléatoirement et stocké en `sessionStorage` (détruit dès la fermeture de
   l'onglet de navigation).
5. **Droit d'opposition immédiat et sans friction (Opt-out)** :
   - Prise en compte automatique des signaux navigateurs `Do Not Track` (`DNT: 1`)
     et `Global Privacy Control` (`GPC: true`).
   - Interrupteur d'opposition accessible à tout moment sur la page publique `/cookies`.
   - L'opposition n'entraîne aucune dégradation du service ni de la navigation.

---

## 2. Données collectées et pseudonymisation

- **Acteurs authentifiés** : Aucun identifiant Discord de personne physique n'est
  inscrit en clair dans le journal des événements `acquisition_events`.
  L'identifiant fait l'objet d'un hachage cryptographique irréversible `HMAC-SHA256`
  avec clé secrète d'instance (`ANALYTICS_HASH_SECRET`).
- **Visiteurs anonymes** : L'identifiant `visitorId` est un UUID v4 aléatoire
  temporaire. L'adresse IP du visiteur n'est jamais journalisée en base de données.
- **Référents** : Seule la catégorie générique du référent (`discord`, `google_search`,
  `direct`, etc.) est conservée. L'URL complète ou la requête de recherche n'est
  jamais stockée pour éviter toute capture de données sensibles.
- **Identifiants serveurs** : Le `guildId` est une donnée relative à l'entité
  cliente (le serveur Discord) et reste conservé pour les métriques de cycle de vie.

---

## 3. Durées de conservation et purge automatique

| Table / Donnée | Durée de conservation | Justification / Action |
| --- | --- | --- |
| `acquisition_events.visitorId` | **30 jours** | Purge quotidienne par le cron `acquisition-events-prune`. |
| `acquisition_events` (journal) | **13 mois** | Permet une comparaison d'une année sur l'autre (M vs M-12). Purge quotidienne au-delà. |
| `guild_lifecycles` | Durée de vie du compte + archive | Données relatives à l'entreprise cliente, sans donnée personnelle directe. |
| `billing_invoices` | **10 ans** | Obligations légales comptables et fiscales (art. L123-22 du code de commerce). |
| `billing_consents` | Durée contractuelle + 5 ans | Conservation de la preuve du consentement aux CGV et de la renonciation au droit de rétractation (art. L221-25 et L221-28 C. conso). |
| `analytics_daily_snapshots` | Indéfinie | Statistiques 100% agrégées et anonymisées ne contenant aucun identifiant individuel. |

---

## 4. Sortie et droit à l'oubli

- Lors du retrait du bot d'un serveur (`Events.GuildDelete`), une tâche de fond
  anonymise sous 30 jours les traces individuelles résiduelles (`actorHash`, `visitorId`)
  rattachées à ce serveur dans le journal `acquisition_events`.
- Le serveur reste comptabilisé dans les agrégats de rétention et de churn
  dans `guild_lifecycles` afin de préserver l'intégrité comptable et statistique
  du service.
