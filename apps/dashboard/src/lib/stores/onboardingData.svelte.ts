/**
 * Ce que le parcours a lu du serveur, partage par tous ses ecrans.
 *
 * A onze ecrans, un composant unique portait tout : la maquette, la
 * facturation, les roles, les salons. A vingt-deux ecrans repartis en autant de
 * fichiers, il fallait choisir entre faire descendre une dizaine de proprietes
 * a travers chaque ecran, ou poser ce qui est commun a un seul endroit. C'est
 * le second, et ce n'est pas qu'une commodite : la liste des roles est demandee
 * par l'ecran « progression » et par l'ecran « equipe », qui ne se suivent pas
 * et n'ont aucune raison de la charger deux fois.
 *
 * Rien ici n'est persiste. Ce sont des lectures du serveur, valables le temps
 * de la session : les reponses, elles, vivent dans `onboardingWizard`.
 *
 * Chaque chargeur est idempotent et silencieux. Un ecran demande ce dont il a
 * besoin en s'affichant ; s'il l'a deja, rien ne part sur le reseau, et si la
 * lecture echoue on se retrouve avec une liste vide plutot qu'avec un ecran
 * bloque - on peut toujours configurer le reste et revenir.
 */
import {
  fetchServerTemplate,
  fetchBillingStatus,
  fetchGuildState,
  fetchMigrationPlan,
  type BillingStatus,
  type ServerTemplateState,
} from '../api';

export type GuildRole = { id: string; name: string; color?: string };
export type GuildChannel = { id: string; name: string; type?: number | string };

/** Un bot tiers reconnu sur le serveur, avec ce qu'il couvre. */
export type DetectedBot = {
  id: string;
  username: string;
  label: string | null;
  key: string | null;
  avatarUrl: string;
  covers: string[];
  activeFeatures: { feature: string; evidence: string }[];
};

/**
 * Contenu relu dans les messages du serveur, tel qu'il sera ecrit.
 *
 * Ce n'est pas un resume de la proposition : c'est la valeur exacte que
 * l'application posera. L'afficher permet de la relire avant de l'appliquer,
 * ce qui compte d'autant plus qu'elle est devinee.
 */
export type InspectionPayload =
  | { kind: 'welcome'; channelId: string; message: string }
  | {
      kind: 'rules';
      channelId: string;
      articles: { emoji: string | null; title: string; description: string }[];
    }
  | {
      kind: 'ticketPanel';
      channelId: string;
      title: string;
      description: string;
      buttonText: string;
      color: string | null;
      embedType: 'BUTTONS' | 'DROPDOWN';
      types: { id: string; label: string; description: string; emoji: string }[];
    }
  | {
      kind: 'reactionRoles';
      channelId: string;
      title: string;
      options: { emoji: string; label: string; roleId: string }[];
    };

/** Une trouvaille de la reprise : ce que Kotbo propose de recuperer. */
export type ScanFinding = {
  key: string;
  feature: string;
  title: string;
  detail: string;
  action: string | null;
  entities: { id: string; name: string }[];
  payload?: InspectionPayload;
};

export type MigrationPlan = {
  bots: DetectedBot[];
  findings: ScanFinding[];
  manualSteps: { feature: string; label: string; why: string }[];
};

let template = $state<ServerTemplateState | null>(null);
let billing = $state<BillingStatus | null>(null);
let roles = $state<GuildRole[]>([]);
let channels = $state<GuildChannel[]>([]);
let migration = $state<MigrationPlan | null>(null);

let rolesLoaded = $state(false);
let migrationLoaded = $state(false);
let migrationLoading = $state(false);
let busy = $state(false);

/**
 * Ce que le montage a reellement pose.
 *
 * Renseigne par l'ecran « structure », relu par le recapitulatif et par l'ecran
 * de paiement. Ce sont les seuls chiffres du parcours qu'on ne peut pas
 * recalculer : ils viennent de la reponse du serveur, pas de la selection.
 */
export type BuildResult = { roles: number; categories: number; channels: number; modules: number };
let built = $state<BuildResult | null>(null);

export const onboardingData = {
  get template() { return template; },
  get billing() { return billing; },
  get roles() { return roles; },
  get channels() { return channels; },
  get migration() { return migration; },
  get migrationLoading() { return migrationLoading; },
  get migrationLoaded() { return migrationLoaded; },
  get built() { return built; },
  get busy() { return busy; },

  set busy(value: boolean) { busy = value; },
  set built(value: BuildResult | null) { built = value; },
  set template(value: ServerTemplateState | null) { template = value; },

  /** Les deux lectures sans lesquelles aucun ecran ne peut s'afficher. */
  async loadCore(): Promise<void> {
    const [tpl, bill] = await Promise.all([
      fetchServerTemplate(),
      // La facturation peut etre desactivee sur l'instance : son absence n'est
      // pas une erreur, et le dernier ecran sait s'en passer.
      fetchBillingStatus().catch(() => null),
    ]);
    template = tpl;
    billing = bill;
  },

  /**
   * Roles et salons du serveur, pour les listes deroulantes.
   *
   * Les roles geres par Discord lui-meme - `@everyone`, roles de bots - ne
   * peuvent etre ni attribues en recompense ni declares comme staff : les
   * proposer serait offrir un choix qui echouerait a l'enregistrement.
   */
  async loadGuild(force = false): Promise<void> {
    if (rolesLoaded && !force) return;
    rolesLoaded = true;
    try {
      const state = await fetchGuildState();
      const discordRoles = (state?.discordRoles ?? []) as { id?: string; name?: string; color?: string }[];
      roles = discordRoles.filter(
        (role): role is GuildRole => !!role?.id && !!role?.name && role.name !== '@everyone',
      );

      const discordChannels = (state?.discordChannels ?? []) as { id?: string; name?: string; type?: number | string }[];
      channels = discordChannels.filter(
        (channel): channel is GuildChannel => !!channel?.id && !!channel?.name,
      );
    } catch {
      roles = [];
      channels = [];
    }
  },

  /**
   * Ce que le serveur porte deja d'autres bots.
   *
   * Lance des l'ecran « neuf ou existant » quand la reponse est « existant » :
   * l'inspection prend quelques secondes, et personne n'a envie de les passer
   * devant un ecran qui tourne. Le temps d'arriver a l'ecran de reprise, la
   * reponse est la.
   */
  async loadMigration(): Promise<void> {
    if (migrationLoaded || migrationLoading) return;
    migrationLoading = true;
    try {
      const plan = await fetchMigrationPlan();
      migration = (plan as MigrationPlan | null) ?? { bots: [], findings: [], manualSteps: [] };
      migrationLoaded = true;
    } catch {
      // Un scan qui echoue ne bloque pas la reprise : les ecrans suivants
      // configurent le serveur comme si l'on n'avait rien trouve.
      migration = { bots: [], findings: [], manualSteps: [] };
      migrationLoaded = true;
    } finally {
      migrationLoading = false;
    }
  },

  /** Relit la maquette. Necessaire apres un changement de langue. */
  async refreshTemplate(): Promise<void> {
    template = await fetchServerTemplate();
  },
};
