export const configRateLimiter = new Map<string, number[]>();

/**
 * Pages publiques des clans. Le classement est mis en cache et servi tel quel à
 * tout le monde, d'où un plafond large ; la recherche, elle, tape la base à
 * chaque appel, mais elle est déclenchée par une frappe humaine (avec un délai
 * d'attente côté page), donc une trentaine d'appels par minute suffit largement.
 */
export const publicClansRateLimiter = new Map<string, number[]>();
export const publicClanSearchRateLimiter = new Map<string, number[]>();

/**
 * Pages publiques des giveaways. Même profil que le classement de clans : la
 * réponse est mise en cache et identique pour tout le monde, mais un giveaway
 * en cours se consulte en boucle (le compte à rebours donne envie de rafraîchir),
 * d'où un plafond large qui n'arrête qu'une page partie en vrille.
 */
export const publicGiveawaysRateLimiter = new Map<string, number[]>();
export const errorReportRateLimiter = new Map<string, number[]>();
export const feedbackReportRateLimiter = new Map<string, number[]>();
export const partnershipRateLimiter = new Map<string, number[]>();
/**
 * Mesure d'audience de la landing. Son propre seau plutot qu'un seau partage :
 * une page qui part en boucle ne doit pas empecher un visiteur d'installer le
 * bot ou de signaler une erreur.
 */
export const funnelRateLimiter = new Map<string, number[]>();

/**
 * Écritures du dashboard, indexées par membre + serveur (et non par IP : deux
 * admins derrière la même sortie réseau ne doivent pas se pénaliser).
 *
 * `dashboardWriteRateLimiter` est un garde-fou large : il ne gêne aucun usage
 * humain, mais coupe une boucle de requêtes partie en vrille côté panel.
 * `dashboardSensitiveRateLimiter` couvre le petit lot d'actions coûteuses ou
 * irréversibles (enregistrement de réglages, clôture de semaine, remises à zéro
 * de clans), où même quelques appels par minute n'ont aucun sens légitime.
 */
export const dashboardWriteRateLimiter = new Map<string, number[]>();
export const dashboardSensitiveRateLimiter = new Map<string, number[]>();

/**
 * Aperçu de la carte de rang, indexé par membre. C'est la route utilisateur la
 * plus coûteuse : un canvas complet par appel, là où le reste ne fait que lire
 * des lignes.
 *
 * Le plafond est large à dessein. Chaque changement de fond ou d'emoji déclenche
 * un aperçu, et parcourir les dix fonds puis essayer des emojis atteint vite
 * plusieurs dizaines d'appels en une minute d'usage parfaitement normal : un
 * seuil serré punirait l'exploration, qui est précisément le but du panneau. Il
 * ne sert qu'à arrêter une page partie en boucle.
 */
export const rankCardPreviewRateLimiter = new Map<string, number[]>();
