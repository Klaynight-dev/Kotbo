/**
 * L'adresse qu'on voulait ouvrir avant que la connexion s'interpose.
 *
 * Le tunnel d'acquisition commence par un lien qui mene a `/servers` : c'est
 * la, et nulle part ailleurs, qu'on choisit le serveur a equiper. Un visiteur
 * qui clique « Ajouter le bot » n'a pourtant presque jamais de session ouverte
 * - il decouvre Kotbo. Il etait donc renvoye sur la connexion, puis, une fois
 * connecte, depose sur `/`, c'est-a-dire le tableau de bord d'un serveur
 * quelconque : la page qu'il avait demandee etait perdue en chemin, et avec
 * elle la raison de son clic.
 *
 * L'API sait deja revenir quelque part - `?returnTo=` sur la route de
 * connexion, repris a la fin du va-et-vient OAuth. Il manquait seulement de le
 * lui dire. Ce module garde l'adresse entre le moment ou la garde detourne
 * vers `/login` et le moment ou le bouton part vers Discord.
 *
 * `sessionStorage` : l'aller-retour tient dans un onglet, et une intention
 * oubliee en `localStorage` detournerait une connexion des semaines plus tard.
 * La valeur est consommee a la lecture - elle ne vaut que pour ce trajet-ci.
 */
const KEY = 'kotbo-login-return-to';

/** Vrai pour un chemin interne. `//ailleurs.example` est une URL absolue deguisee. */
function isInternalPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

/**
 * Retenir l'adresse demandee, juste avant de detourner vers la connexion.
 *
 * `/` et `/login` ne valent pas la peine d'etre retenus : le premier est deja
 * la destination par defaut, le second serait une boucle.
 */
export function rememberLoginReturn(url: string): void {
  if (!isInternalPath(url)) return;
  const path = url.split('?')[0];
  if (path === '/' || path === '/login') return;
  try {
    sessionStorage.setItem(KEY, url);
  } catch {
    // Stockage refuse : la connexion ramenera a l'accueil, comme avant.
  }
}

/** Lit l'adresse retenue et l'oublie. `null` quand il n'y en a pas. */
export function consumeLoginReturn(): string | null {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored) sessionStorage.removeItem(KEY);
    return stored && isInternalPath(stored) ? stored : null;
  } catch {
    return null;
  }
}
