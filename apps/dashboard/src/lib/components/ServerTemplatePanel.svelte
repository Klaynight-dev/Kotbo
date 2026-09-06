<script lang="ts">
  import InlineFeedback from './InlineFeedback.svelte';
  import Papicon from './Papicon.svelte';
  import Skeleton from './Skeleton.svelte';
  import { createAsyncActionState } from '../asyncAction.svelte';
  import { confirmDialog } from '../stores/confirmDialog.svelte';
  import { toast } from '../stores/toast.svelte';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import { authStore } from '../stores/auth.svelte';
  import {
    fetchServerTemplate,
    applyServerTemplate,
    fetchGuildLanguage,
    updateGuildLanguage,
    type GuildLanguageState,
    type ServerTemplateApplyFailure,
    type ServerTemplateApplyResult,
    type ServerTemplatePlanItem,
    type ServerTemplateSection,
    type ServerTemplateState,
  } from '../api';
  import { m } from '../i18n';

  /**
   * Le bloc de mise en place du serveur, tel qu'il vit dans la prise en main.
   *
   * Il fut une page a lui seul : poser les salons et cocher ce qu'il reste a
   * regler sont pourtant le meme moment, celui de l'arrivee sur un serveur
   * neuf. La page hote a besoin de deux choses de lui - savoir si la mise en
   * place est deja faite, pour ne pas dresser un long formulaire devenu sans
   * objet, et etre prevenue quand elle vient de se faire, pour relire aussitot
   * son parcours.
   */
  const { onApplied, onLoaded }: {
    onApplied?: () => void;
    onLoaded?: (state: { applied: boolean }) => void;
  } = $props();

  let loading = $state(true);
  let loadError = $state('');
  let template = $state<ServerTemplateState | null>(null);
  let selection = $state(new Set<string>());
  /**
   * Ce que l'administrateur designe comme deja en place : clef du plan vers
   * identifiant Discord.
   *
   * Le meme geste que dans le parcours de configuration, ouvert ici pour la
   * meme raison : la mise en place ne reconnaissait un element que par la trace
   * d'une pose precedente ou par la ressemblance de son nom, et recreait tout
   * le reste. Un serveur qui range ses journaux dans `#journal` en ressortait
   * avec un `#logs` de plus. On peut desormais dire lequel est lequel, et le
   * corriger apres coup - la detection ne fait plus que pre-remplir.
   */
  let adopt = $state<Record<string, string>>({});
  let language = $state<GuildLanguageState | null>(null);
  let languageLoading = $state(false);

  const applyAction = createAsyncActionState();

  // La section captcha n'a pas sa place ici : elle se coche d'un bloc depuis le
  // choix de verification, plus bas.
  const SECTION_ORDER: ServerTemplateSection[] = ['access', 'security', 'staff', 'captcha', 'tickets', 'welcome', 'stats', 'text', 'fun', 'bots', 'voice'];

  const SECTION_LABELS: Record<ServerTemplateSection, () => string> = {
    access: m.st_section_access,
    security: m.st_section_security,
    staff: m.st_section_staff,
    captcha: m.st_section_captcha,
    tickets: m.st_section_tickets,
    welcome: m.st_section_welcome,
    stats: m.st_section_stats,
    text: m.st_section_text,
    fun: m.st_section_fun,
    bots: m.st_section_bots,
    voice: m.st_section_voice,
    modules: m.st_section_modules,
  };

  const WIRING_LABELS: Record<string, () => string> = {
    staff: m.st_wiring_staff,
    logs: m.st_wiring_logs,
    tickets: m.st_wiring_tickets,
    leveling: m.st_wiring_leveling,
    rpg: m.st_wiring_rpg,
    tempvoice: m.st_wiring_tempvoice,
    welcome: m.st_wiring_welcome,
    rules: m.st_wiring_rules,
    member: m.st_wiring_member,
    captcha: m.st_wiring_captcha,
    honeypot: m.st_wiring_honeypot,
    starboard: m.st_wiring_starboard,
    stats: m.st_wiring_stats,
    autothread: m.st_wiring_autothread,
  };

  /** A qui le salon s'ouvre, tout le plan etant ferme a @everyone. */
  const AUDIENCE_LABELS: Record<string, () => string> = {
    staff: m.st_audience_staff,
    member: m.st_audience_member,
    pending: m.st_audience_pending,
    everyone: m.st_audience_everyone,
  };

  /** Nom et role de chaque module, le service n'envoyant que son identifiant. */
  const MODULE_LABELS: Record<string, { name: () => string; desc: () => string }> = {
    tickets: { name: m.st_module_tickets, desc: m.st_module_tickets_desc },
    leveling: { name: m.st_module_leveling, desc: m.st_module_leveling_desc },
    economy: { name: m.st_module_economy, desc: m.st_module_economy_desc },
    nickname_moderation: { name: m.st_module_nickname_moderation, desc: m.st_module_nickname_moderation_desc },
    automod: { name: m.st_module_automod, desc: m.st_module_automod_desc },
    channel_health: { name: m.st_module_channel_health, desc: m.st_module_channel_health_desc },
    raid_protection: { name: m.st_verification_captcha, desc: m.st_verification_captcha_desc },
  };

  const plan = $derived(template?.plan ?? []);
  const alreadyApplied = $derived(template?.applied ?? null);
  const missingPermissions = $derived(template?.missingPermissions ?? []);

  /**
   * Les sections dans l'ordre du plan, chaque categorie portant ses salons :
   * la colonne des options et l'apercu lisent la meme structure, ils ne
   * peuvent donc pas se contredire.
   */
  const sections = $derived(
    SECTION_ORDER
      .map((id) => {
        const items = plan.filter((entry) => entry.section === id);
        return {
          id,
          label: SECTION_LABELS[id](),
          roles: items.filter((entry) => entry.kind === 'role'),
          // Salons sans categorie : Discord les affiche tout en haut de la
          // colonne, au-dessus des categories, et l'apercu doit s'y tenir.
          loose: items.filter((entry) => !entry.parent && (entry.kind === 'text' || entry.kind === 'voice')),
          categories: items
            .filter((entry) => entry.kind === 'category')
            .map((category) => ({
              category,
              channels: items.filter((entry) => entry.parent === category.key),
            })),
        };
      })
      .filter((section) => section.roles.length > 0 || section.loose.length > 0 || section.categories.length > 0),
  );

  /** L'arborescence des options, captcha exclu : il a son propre bloc. */
  const treeSections = $derived(sections.filter((section) => section.id !== 'captcha'));

  /** Les modules vivent hors de l'arborescence : ils ont leur propre bloc. */
  const moduleItems = $derived(plan.filter((entry) => entry.kind === 'module'));
  const selectedModules = $derived(moduleItems.filter((entry) => selection.has(entry.key)));

  const looseChannels = $derived(
    plan.filter((entry) => !entry.parent && ['text', 'voice'].includes(entry.kind) && selection.has(entry.key)),
  );

  const captchaItems = $derived(plan.filter((entry) => entry.section === 'captcha'));
  const captchaOn = $derived(captchaItems.some((entry) => selection.has(entry.key)));
  const memberRole = $derived(plan.find((entry) => entry.key === 'role.member') ?? null);
  // Sans role Membre, ni l'auto-role ni le captcha n'ont rien a accorder : le
  // choix de verification perd son objet.
  const hasMemberRole = $derived(selection.has('role.member'));

  const selectedCount = $derived(selection.size);
  const selectedRoles = $derived(plan.filter((entry) => entry.kind === 'role' && selection.has(entry.key)));
  const selectedChannelsCount = $derived(
    plan.filter((entry) => ['category', 'text', 'voice'].includes(entry.kind) && selection.has(entry.key)).length,
  );
  // Sans le droit de creer des salons rien n'est possible. Les autres manques
  // ne concernent qu'une partie du plan : le bouton reste ouvert, et le serveur
  // tranche sur la selection reellement envoyee.
  const canApply = $derived(
    !alreadyApplied && (template?.canCreateChannels ?? false) && selectedCount > 0 && !applyAction.state.loading,
  );

  /**
   * Une mise en place deja faite ne se relance pas, et rien ne part pendant
   * qu'elle tourne : la selection est alors figee, elle n'est plus la que pour
   * montrer ce qui a ete pose.
   */
  const selectionLocked = $derived(!!alreadyApplied || applyAction.state.loading);

  // Le survol continuerait d'eclaircir les cases d'une selection figee : CSS
  // ignore `disabled` pour `:hover`, il faut donc retirer la classe.
  const checkboxHover = $derived(selectionLocked ? '' : 'group-hover:border-outline-variant');
  const choiceHover = $derived(selectionLocked ? '' : 'hover:border-outline-variant/40');
  // La langue reste modifiable apres la mise en place : elle ne suit pas le
  // verrou de la selection, seulement sa propre requete en cours.
  const languageHover = $derived(languageLoading ? '' : 'hover:border-outline-variant/40');

  function isChecked(key: string): boolean {
    return selection.has(key);
  }

  /**
   * Ce que le serveur peut offrir pour tenir ce role-la.
   *
   * Filtre sur la nature - un vocal ne remplace pas un salon textuel, le bot
   * refuserait - et sur ce qui n'est pas deja pris par une autre ligne : un
   * meme salon recevrait deux cablages contradictoires, et le second effacerait
   * le premier.
   */
  function adoptCandidates(item: ServerTemplatePlanItem): { id: string; name: string }[] {
    const inventory = template?.inventory;
    if (!inventory) return [];

    const taken = new Set(
      Object.entries(adopt)
        .filter(([key, id]) => key !== item.key && !!id)
        .map(([, id]) => id),
    );

    if (item.kind === 'role') {
      return inventory.roles
        .filter((role) => role.assignable && !taken.has(role.id))
        .map((role) => ({ id: role.id, name: `@${role.name}` }));
    }

    return inventory.channels
      .filter((channel) => channel.kind === item.kind && !taken.has(channel.id))
      .map((channel) => ({ id: channel.id, name: channel.name }));
  }

  /** Kotbo l'a pose lui-meme : la ligne est reliee et ne se redesigne pas. */
  function isTraced(key: string): boolean {
    return template?.matches?.[key]?.source === 'ref';
  }

  function setAdopt(key: string, id: string): void {
    const next = { ...adopt };
    if (id) next[key] = id;
    else delete next[key];
    adopt = next;
  }

  /**
   * Une categorie n'existe que par ses salons : cocher un salon la ramene,
   * decocher le dernier l'emporte. C'est la meme regle que celle appliquee
   * cote serveur, la page ne fait que la rendre visible tout de suite.
   */
  function syncCategories(next: Set<string>): Set<string> {
    for (const section of sections) {
      for (const { category, channels } of section.categories) {
        const hasChannel = channels.some((channel) => next.has(channel.key));
        if (hasChannel) next.add(category.key);
        else next.delete(category.key);
      }
    }
    return next;
  }

  /** Les elements indispensables suivent leur section, ils ne se decochent pas seuls. */
  function syncRequired(next: Set<string>): Set<string> {
    for (const section of sections) {
      const sectionKeys = plan.filter((entry) => entry.section === section.id);
      const active = sectionKeys.some((entry) => next.has(entry.key));
      for (const entry of sectionKeys) {
        if (!entry.required) continue;
        if (active) next.add(entry.key);
        else next.delete(entry.key);
      }
    }
    return next;
  }

  /**
   * Cocher un salon coche le module qui s'en sert : poser un salon de niveaux
   * sans allumer le leveling ne produirait rien.
   *
   * Le lien ne joue qu'a l'allumage, et seulement au moment ou le salon arrive
   * dans la selection. Decocher le salon ne coupe pas le module - il se tient
   * tres bien sans salon dedie - et une fois le module decoche a la main, il le
   * reste : sans cette comparaison avec l'etat precedent, la case se serait
   * recochee toute seule au clic suivant.
   */
  function syncLinkedModules(previous: Set<string>, next: Set<string>): Set<string> {
    for (const entry of moduleItems) {
      if (!entry.linkedTo) continue;
      if (next.has(entry.linkedTo) && !previous.has(entry.linkedTo)) next.add(entry.key);
    }
    return next;
  }

  /**
   * Retablit le lien entre un element et ce sans quoi il ne fonctionne pas -
   * le captcha n'a rien a accorder sans le role Membre. Le lien traverse les
   * sections, la ou `required` ne vaut qu'a l'interieur de l'une d'elles.
   *
   * Le sens vient du clic, pas de la regle. Cocher le captcha doit ramener le
   * role Membre ; decocher le role Membre doit emporter le captcha, et surtout
   * pas se voir annule par la meme regle lue a l'envers.
   *
   * Repete jusqu'a stabilite : une dependance peut elle-meme en avoir une.
   */
  function syncDependencies(next: Set<string>, direction: 'add' | 'drop'): Set<string> {
    for (let pass = 0; pass < plan.length; pass++) {
      let changed = false;
      for (const entry of plan) {
        if (!entry.dependsOn) continue;
        if (!next.has(entry.key) || next.has(entry.dependsOn)) continue;
        if (direction === 'add') next.add(entry.dependsOn);
        else next.delete(entry.key);
        changed = true;
      }
      if (!changed) break;
    }
    return next;
  }

  /**
   * `linkModules` a false quand la selection vient d'ailleurs que d'un clic -
   * celle enregistree lors d'une mise en place passee, par exemple. Elle fait
   * alors foi telle quelle : la liaison recocherait un module que l'admin avait
   * justement decoche.
   */
  /**
   * `removing` dit dans quel sens resoudre les dependances : un clic qui
   * decoche emporte ce qui en dependait, un clic qui coche ramene ce dont
   * l'element depend.
   */
  function commit(next: Set<string>, options: { linkModules?: boolean; removing?: boolean } = {}): void {
    const { linkModules = true, removing = false } = options;
    const synced = syncCategories(syncDependencies(syncRequired(next), removing ? 'drop' : 'add'));
    selection = linkModules ? syncLinkedModules(selection, synced) : synced;
  }

  /**
   * Le captcha se prend ou se laisse d'un bloc : a moitie, il ne verifie rien.
   *
   * Les deux choix supposent le role Membre - sans lui il n'y a rien a accorder,
   * ni a l'arrivee ni apres le code - donc l'un comme l'autre le ramenent.
   */
  function setVerification(captcha: boolean): void {
    const next = new Set(selection);
    next.add('role.member');
    for (const entry of captchaItems) {
      if (captcha) next.add(entry.key);
      else next.delete(entry.key);
    }
    commit(next);
  }

  function toggleItem(item: ServerTemplatePlanItem): void {
    const removing = selection.has(item.key);

    if (item.required && removing) {
      // Decocher la seule piece indispensable revient a retirer la section :
      // c'est ce que fait le clic, plutot que de ne rien faire sans explication.
      const next = new Set(selection);
      for (const entry of plan) {
        if (entry.section === item.section) next.delete(entry.key);
      }
      commit(next, { removing: true });
      return;
    }

    const next = new Set(selection);
    if (removing) next.delete(item.key);
    else next.add(item.key);
    commit(next, { removing });
  }

  function toggleCategory(categoryKey: string, channels: ServerTemplatePlanItem[]): void {
    const next = new Set(selection);
    const allOn = channels.every((channel) => next.has(channel.key));
    for (const channel of channels) {
      if (allOn) next.delete(channel.key);
      else next.add(channel.key);
    }
    if (allOn) next.delete(categoryKey);
    commit(next, { removing: allOn });
  }

  function toggleSection(sectionId: ServerTemplateSection): void {
    const entries = plan.filter((entry) => entry.section === sectionId);
    const allOn = entries.every((entry) => selection.has(entry.key));
    const next = new Set(selection);
    for (const entry of entries) {
      if (allOn) next.delete(entry.key);
      else next.add(entry.key);
    }
    commit(next, { removing: allOn });
  }

  function selectAll(): void {
    const next = new Set(plan.filter((entry) => captchaOn || entry.section !== 'captcha').map((entry) => entry.key));
    commit(next);
  }

  function selectNone(): void {
    selection = new Set();
  }

  function resetSelection(): void {
    commit(new Set(template?.defaultSelection ?? []));
  }

  // ── Serveur neuf ou reprise ──────────────────────────────────────────────
  //
  // La detection sert de defaut, jamais de verrou : elle se trompera sur un
  // serveur prepare en coulisses puis ouvert d'un coup, qui ressemble a un
  // serveur etabli le jour de son lancement. Le bouton ci-dessous existe pour
  // ce cas-la.
  const maturity = $derived(template?.maturity ?? null);
  const isTakeover = $derived(maturity?.maturity === 'established');

  function selectFullTemplate(): void {
    commit(new Set(template?.fullSelection ?? []));
  }

  function sectionState(sectionId: ServerTemplateSection): 'all' | 'some' | 'none' {
    const entries = plan.filter((entry) => entry.section === sectionId);
    const checked = entries.filter((entry) => selection.has(entry.key)).length;
    if (checked === 0) return 'none';
    return checked === entries.length ? 'all' : 'some';
  }

  function wiringLabel(item: ServerTemplatePlanItem): string | null {
    return item.wiring ? WIRING_LABELS[item.wiring]?.() ?? null : null;
  }

  /**
   * L'audience telle qu'elle sera reellement posee sur Discord.
   *
   * Sans role Membre, le service ne ferme rien : un salon ferme sans role a qui
   * le rouvrir ne serait visible que du bot, il le laisse donc ouvert a tous.
   * L'apercu doit suivre, sinon il promet des cadenas qui ne seront pas poses.
   */
  function effectiveAudience(item: ServerTemplatePlanItem): string {
    if (item.audience === 'member' && !hasMemberRole) return 'everyone';
    return item.audience;
  }

  /** Qui voit le salon, et s'il peut y ecrire : le tout en une infobulle. */
  function accessLabel(item: ServerTemplatePlanItem): string {
    const parts = [AUDIENCE_LABELS[effectiveAudience(item)]?.()].filter(Boolean) as string[];
    if (item.readOnly) parts.push(m.st_readonly());
    return parts.join(' · ');
  }

  /** Rien a signaler sur un salon ouvert a tous ou chacun peut parler. */
  function accessIcon(item: ServerTemplatePlanItem): string | null {
    if (effectiveAudience(item) !== 'everyone') return 'Lock';
    return item.readOnly ? 'Eye' : null;
  }

  /** Repli sur le nom envoye par le service pour un module ajoute au plan sans traduction. */
  function moduleName(item: ServerTemplatePlanItem): string {
    return (item.moduleId && MODULE_LABELS[item.moduleId]?.name()) || item.name;
  }

  function moduleDesc(item: ServerTemplatePlanItem): string | null {
    return (item.moduleId && MODULE_LABELS[item.moduleId]?.desc()) || null;
  }

  /** Nom du salon qui a fait cocher ce module, quand il est bien retenu. */
  function moduleLinkName(item: ServerTemplatePlanItem): string | null {
    if (!item.linkedTo || !selection.has(item.linkedTo)) return null;
    return plan.find((entry) => entry.key === item.linkedTo)?.name ?? null;
  }

  /**
   * Module retenu mais prive du salon ou il devait s'exprimer. Ne vaut que
   * pour la sante des salons : elle est la seule a n'avoir aucun repli une fois
   * son salon de logs ecarte, les autres se passent tres bien de salon dedie.
   *
   * Le repli sur un salon de logs deja configure est verifie cote serveur : sans
   * cela la page crierait au loup sur un serveur parfaitement equipe.
   */
  function isModuleMuted(item: ServerTemplatePlanItem): boolean {
    if (item.moduleId !== 'channel_health') return false;
    if (!selection.has(item.key)) return false;
    return !selection.has('staff.log') && !(template?.hasLogChannel ?? false);
  }

  function toggleAllModules(): void {
    const allOn = moduleItems.every((entry) => selection.has(entry.key));
    const next = new Set(selection);
    for (const entry of moduleItems) {
      if (allOn) next.delete(entry.key);
      else next.add(entry.key);
    }
    // `commit` ne recochera rien : la liaison ne joue qu'au moment ou un salon
    // entre dans la selection, et ce bouton n'y touche pas.
    commit(next);
  }

  /**
   * `keepSelection` apres une mise en place interrompue : elle n'est pas
   * enregistree, la selection reviendrait donc a la maquette complete au moment
   * meme ou l'admin veut relancer la sienne.
   *
   * `quiet` quand la page est deja affichee et qu'on ne relit le plan que pour
   * en rafraichir les noms : la remplacer par ses squelettes ferait clignoter
   * tout l'ecran pour un changement d'etiquettes.
   */
  async function load(options: { keepSelection?: boolean; quiet?: boolean } = {}) {
    if (!options.quiet) loading = true;
    loadError = '';
    try {
      const data = await fetchServerTemplate();
      template = data;

      /**
       * La detection pre-remplit, elle ne tranche pas.
       *
       * Chaque rapprochement - identifiant enregistre ou nom ressemblant -
       * arrive sur « utiliser », visible et modifiable. C'est la difference qui
       * comptait : le meme rapprochement se faisait avant en silence, et ce
       * qu'il ratait se recreait sans que personne ait eu l'occasion de dire
       * que le salon existait deja sous un autre nom.
       */
      if (!options.keepSelection) {
        adopt = Object.fromEntries(
          Object.entries(data?.matches ?? {}).map(([key, match]) => [key, match.id]),
        );
      }
      // La page hote ouvre ou replie le bloc selon cet etat : elle ne peut pas
      // le lire elle-meme, le plan n'etant charge qu'ici.
      onLoaded?.({ applied: !!data?.applied });
      // Une mise en place deja faite est rendue telle qu'elle a ete lancee :
      // l'admin doit retrouver ce qu'il avait coche, pas la maquette complete.
      if (!options.keepSelection) {
        commit(new Set(data?.applied?.selection?.length ? data.applied.selection : data?.defaultSelection ?? []), { linkModules: false });
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : m.st_err_load();
    } finally {
      loading = false;
    }
  }

  async function loadLanguage() {
    languageLoading = true;
    try {
      language = await fetchGuildLanguage();
    } finally {
      languageLoading = false;
    }
  }

  /**
   * Le plan est renvoye avec ses noms rendus dans la langue du serveur : le
   * relire apres coup est ce qui fait basculer la previsualisation, sans quoi
   * l'admin choisirait l'anglais devant une colonne restee en francais.
   */
  async function setLanguage(payload: { mode: 'auto' } | { language: 'fr' | 'en' }): Promise<void> {
    if (languageLoading) return;
    languageLoading = true;
    try {
      const state = await updateGuildLanguage(payload);
      if (!state) return;
      language = state;

      // Changer de langue republie les panneaux deja poses - reglement,
      // tickets, roles-reaction. Le taire laisserait croire qu'ils sont restes
      // dans l'ancienne langue, ou qu'ils ont tous suivi alors que non.
      if (state.rerender?.failed) {
        toast.error(m.home_botlanguage_panels_failed({ n: state.rerender.failed }));
      } else if (state.rerender?.updated) {
        toast.success(m.home_botlanguage_panels_updated({ n: state.rerender.updated }));
      }

      await load({ keepSelection: true, quiet: true });
    } catch {
      // Le socle a deja dit ce qui n'allait pas ; l'etat affiche reste celui
      // du serveur, la page n'a rien a rattraper.
    } finally {
      languageLoading = false;
    }
  }

  const languageLabel = (code: 'fr' | 'en') => (code === 'fr' ? m.home_botlanguage_fr() : m.home_botlanguage_en());

  /**
   * Le bloc etait une page a lui seul : changer de serveur le remontait, et il
   * repartait de zero. Il vit maintenant dans une page qui, elle, ne remonte
   * pas - d'ou cette relecture, sans quoi le plan affiche resterait celui du
   * serveur precedent, cases cochees comprises.
   */
  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;
    void load();
    void loadLanguage();
  });

  /**
   * Rend compte d'une mise en place refusee ou interrompue : ce qui a ete cree
   * avant la coupure, puis rechargement du plan des que l'etat de la page ne
   * correspond plus a celui du serveur.
   */
  async function reportPartialApply(err: unknown): Promise<void> {
    const failure = (err as { data?: ServerTemplateApplyFailure })?.data;
    const items = failure?.items ?? [];
    if (items.length > 0) {
      toast.error(m.st_partial_detail({
        created: items.filter((entry) => entry.created).map((entry) => entry.name).join(', ') || '-',
        reused: items.filter((entry) => !entry.created).map((entry) => entry.name).join(', ') || '-',
      }));
    }
    for (const warning of failure?.warnings ?? []) {
      toast.error(`${m.st_warnings_title()} · ${warning}`);
    }

    // Le serveur refuse aussi une mise en place menee entre-temps depuis un
    // autre onglet : la page doit passer en « deja faite », sinon elle continue
    // d'inviter a relancer ce qui ne se relancera plus. Un refus pour mise en
    // place encore en cours, lui, ne change rien : elle se retente, et la
    // selection de l'admin doit lui rester sous les yeux.
    const appliedElsewhere = !!failure?.appliedAt;
    if (items.length === 0 && !appliedElsewhere) return;

    await dashboardStore.refresh();
    // La selection n'est enregistree qu'a l'issue d'une mise en place complete :
    // apres une interruption, la recharger la ramenerait a la maquette complete
    // au moment meme ou l'admin veut relancer la sienne.
    await load({ keepSelection: !appliedElsewhere });
  }

  async function handleApply() {
    if (!canApply) return;
    // Les modules changent le comportement du bot pour tout le serveur : ils
    // sont annonces a part, et non noyes dans le compte des salons.
    const moduleNames = selectedModules.map((entry) => moduleName(entry)).join(', ');
    if (!(await confirmDialog.ask({
      title: m.st_confirm_title(),
      description: moduleNames
        ? `${m.st_confirm_desc({ count: selectedCount - selectedModules.length })} ${m.st_confirm_modules({ modules: moduleNames })}`
        : m.st_confirm_desc({ count: selectedCount - selectedModules.length }),
      confirmLabel: m.st_confirm_label(),
      variant: 'warning',
    }))) return;

    await applyAction.run(async () => {
      let result: ServerTemplateApplyResult;
      try {
        result = await applyServerTemplate([...selection], adopt);
      } catch (err) {
        // Une mise en place interrompue rend quand meme ce qu'elle avait deja
        // fait. Sans ce rattrapage, l'admin lirait « interrompue » sans savoir
        // quels salons existent desormais sur son serveur, et la page
        // continuerait d'afficher un serveur vierge.
        await reportPartialApply(err);
        throw err;
      }
      if (!result?.success) throw new Error(m.st_err_apply());

      const created = result.items.filter((entry) => entry.created).map((entry) => entry.name);
      const reused = result.items.filter((entry) => !entry.created).map((entry) => entry.name);
      toast.success(m.st_success_detail({
        created: created.join(', ') || '-',
        reused: reused.join(', ') || '-',
      }));
      if (result.modules?.length) {
        // Traduits pour l'affichage : le service ne rend que des identifiants.
        const names = result.modules.map((id) => MODULE_LABELS[id]?.name() ?? id);
        toast.success(m.st_success_modules({ modules: names.join(', ') }));
      }
      // Configures mais encore inertes : le dire franchement plutot que de les
      // taire, sinon l'admin croit son serveur en place et decouvre plus tard
      // que la moitie ne s'execute pas. Le ton n'est pas celui d'une erreur -
      // rien n'a echoue, il manque un abonnement, et rien ne sera a refaire.
      if (result.preparedModules?.length) {
        const names = result.preparedModules.map((id) => MODULE_LABELS[id]?.name() ?? id);
        toast.info(
          `${names.length} module(s) configurés et prêts : ${names.join(', ')}. Ils s'activeront dès la souscription, sans rien avoir à refaire.`,
          12_000,
          { label: 'Voir les offres', onClick: () => { window.location.href = '/billing'; } },
        );
      }
      if (result.panelSent) toast.success(m.st_panel_sent());

      // Une etape facultative refusee - la synchronisation AutoMod native sans
      // « Gerer le serveur », par exemple - n'arrete pas la mise en place mais
      // ne doit pas passer inapercue : le reste a bien ete fait.
      for (const warning of result.warnings ?? []) {
        toast.error(`${m.st_warnings_title()} · ${warning}`);
      }

      // Les nouveaux salons doivent apparaitre dans les selecteurs des autres
      // pages sans passer par un rechargement complet.
      await dashboardStore.refresh();
      await load();
      // Le parcours de la page hote vient de changer : plusieurs de ses points
      // se cochent d'eux-memes une fois les salons poses.
      onApplied?.();
      return true;
    }, { successMessage: m.st_success(), failureMessage: m.st_err_apply() });
  }
</script>

<div class="flex flex-col gap-6">
  <InlineFeedback state={applyAction} />

  {#if loading}
    <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-8">
      <Skeleton height="420px" radius="0.75rem" />
      <Skeleton height="420px" radius="0.75rem" />
    </div>

  {:else if loadError}
    <div class="flex items-center gap-3 bg-error/5 border border-error/20 rounded-xl px-5 py-4">
      <Papicon icon="AlertTriangle" size={18} class="text-error shrink-0" />
      <p class="text-sm text-on-surface">{loadError}</p>
    </div>

  {:else}
    <!-- Ce qui conditionne la mise en place, dit avant que l'admin ne coche
         quoi que ce soit : deja faite, permissions manquantes, ou langue des
         salons a venir. -->
    {#if !alreadyApplied && maturity}
      <div class="flex flex-col sm:flex-row sm:items-start gap-4 bg-surface-container-low/60 border border-outline-variant/30 rounded-xl px-6 py-5">
        <div class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 {isTakeover ? 'bg-amber-500/10 text-amber-500' : 'bg-primary/10 text-primary'}">
          <Papicon icon={isTakeover ? 'Users' : 'sparkles'} size={20} />
        </div>
        <div class="space-y-1 min-w-0 flex-1">
          <p class="text-sm font-semibold text-on-surface">
            {isTakeover ? 'Serveur déjà en activité : reprise' : 'Serveur neuf : création complète'}
          </p>
          <p class="text-[13px] text-on-surface-variant/70 leading-relaxed">
            {#if isTakeover}
              Seuls les modules sont cochés. Créer la maquette complète ici doublerait des
              salons dont vos membres se servent déjà - à cocher vous-même, salon par salon,
              si vous le voulez vraiment.
            {:else}
              Rien n'indique une communauté installée : la maquette complète est cochée,
              salons et rôles compris.
            {/if}
          </p>
          {#if maturity.reasons.length > 0}
            <p class="text-[12px] text-on-surface-variant/50">
              Constaté : {maturity.reasons.join(' · ')}.
            </p>
          {/if}
        </div>
        {#if isTakeover && !selectionLocked}
          <button
            type="button"
            onclick={selectFullTemplate}
            class="shrink-0 h-9 px-3 rounded-lg text-[13px] font-medium text-on-surface-variant border border-outline-variant/40 hover:bg-surface-container-high transition-colors"
          >
            Cocher quand même tout
          </button>
        {/if}
      </div>
    {/if}

    {#if alreadyApplied}
      <div class="flex flex-col sm:flex-row sm:items-center gap-4 bg-primary/5 border border-primary/20 rounded-xl px-6 py-5">
        <div class="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Papicon icon="Check" size={20} />
        </div>
        <div class="space-y-0.5">
          <p class="text-sm font-semibold text-on-surface">{m.st_applied_title()}</p>
          <p class="text-[13px] text-on-surface-variant/70">
            {m.st_applied_by({
              user: alreadyApplied.by ?? '-',
              date: new Date(alreadyApplied.at).toLocaleDateString(),
            })}
            {m.st_applied_hint()}
          </p>
        </div>
      </div>
    {:else if missingPermissions.length > 0}
      <div class="flex flex-col sm:flex-row sm:items-center gap-4 bg-error/5 border border-error/20 rounded-xl px-6 py-5">
        <div class="w-10 h-10 rounded-lg bg-error/10 text-error flex items-center justify-center shrink-0">
          <Papicon icon="Lock" size={20} />
        </div>
        <div class="space-y-0.5">
          <p class="text-sm font-semibold text-on-surface">{m.st_perm_missing_title()}</p>
          <p class="text-[13px] text-on-surface-variant/70">
            {m.st_perm_missing_desc({ permissions: missingPermissions.join(', ') })}
            {m.st_perm_admin_hint()}
          </p>
        </div>
      </div>
    {:else if template?.isAdministrator}
      <div class="flex items-center gap-3 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-5 py-3.5">
        <Papicon icon="ShieldCheck" size={16} class="text-primary shrink-0" />
        <p class="text-[13px] text-on-surface-variant/70">{m.st_perm_ok()}</p>
      </div>
    {/if}

    <!-- La langue du bot commande le nom des salons qui vont etre poses : elle
         se choisit ici, devant la previsualisation qui la reflete, plutot que
         sur une autre page une fois le serveur monte. -->
    {#if language}
      <section class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-6 py-5 space-y-4">
        <div class="flex items-start gap-3">
          <div class="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Papicon icon="Globe" size={20} />
          </div>
          <div class="min-w-0 space-y-0.5">
            <h3 class="text-base font-semibold text-on-surface">{m.home_botlanguage()}</h3>
            <p class="text-[13px] text-on-surface-variant/60">
              {#if alreadyApplied}
                {m.home_botlanguage_hint()}
              {:else}
                <!-- La langue des salons ne suit pas celle du dashboard mais
                     celle du serveur : le dire evite la surprise d'un salon en
                     anglais. -->
                {template?.locale === 'en' ? m.st_locale_notice_en() : m.st_locale_notice()}
              {/if}
            </p>
          </div>
        </div>

        <!-- Deux cibles pleine largeur plutot que deux pastilles : c'est le
             reglage qui nomme tous les salons a venir, il se voit et se change
             d'un clic. Meme forme que le choix de verification plus bas. -->
        <div class="grid sm:grid-cols-2 gap-2">
          {#each language.available as code (code)}
            {@render languageChoice(code)}
          {/each}
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <!-- Ce que vaudrait le mode automatique : sans cette ligne, le bouton
               qui y renvoie ne dit pas ou il mene. -->
          <p class="text-[12px] text-on-surface-variant/50">
            {#if language.detected}
              {m.home_botlanguage_detected({ lang: languageLabel(language.detected) })}
            {:else}
              {m.home_botlanguage_detected_none()}
            {/if}
          </p>
          <button
            type="button"
            disabled={languageLoading || language.mode === 'auto'}
            onclick={() => setLanguage({ mode: 'auto' })}
            class="px-3 py-1.5 text-[12px] font-medium rounded-lg text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            {m.home_botlanguage_auto_action()}
          </button>
        </div>
      </section>
    {/if}

    <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-8 items-start">

      <!-- Colonne des options -->
      <section class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl overflow-hidden">
        <header class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-6 py-5 border-b border-outline-variant/10">
          <div class="space-y-0.5">
            <h3 class="text-base font-semibold text-on-surface">{m.st_options_title()}</h3>
            <p class="text-[13px] text-on-surface-variant/60">{m.st_options_hint()}</p>
          </div>
          <!-- Verrouilles des que la selection ne peut plus partir : la modifier
               laisserait croire qu'elle sera appliquee. -->
          <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" onclick={selectAll} disabled={selectionLocked} class="px-3 py-1.5 text-[12px] font-medium rounded-lg text-on-surface-variant/70 hover:bg-surface-container-high/40 hover:text-on-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-on-surface-variant/70">
              {m.st_select_all()}
            </button>
            <button type="button" onclick={selectNone} disabled={selectionLocked} class="px-3 py-1.5 text-[12px] font-medium rounded-lg text-on-surface-variant/70 hover:bg-surface-container-high/40 hover:text-on-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-on-surface-variant/70">
              {m.st_select_none()}
            </button>
            <button type="button" onclick={resetSelection} disabled={selectionLocked} class="px-3 py-1.5 text-[12px] font-medium rounded-lg text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">
              {m.st_reset_selection()}
            </button>
          </div>
        </header>

        <div class="divide-y divide-outline-variant/10">
          {#each treeSections as section (section.id)}
            {@const status = sectionState(section.id)}
            <div class="px-6 py-5 space-y-3">
              <button
                type="button"
                onclick={() => toggleSection(section.id)}
                disabled={selectionLocked}
                class="flex items-center gap-3 w-full text-left group disabled:cursor-not-allowed"
              >
                <span class="w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors {status === 'all' ? 'bg-primary border-primary text-on-primary' : status === 'some' ? 'border-primary text-primary' : `border-outline-variant/40 text-transparent ${checkboxHover}`}">
                  {#if status === 'all'}
                    <Papicon icon="Check" size={12} />
                  {:else if status === 'some'}
                    <span class="w-2 h-0.5 rounded-full bg-primary"></span>
                  {/if}
                </span>
                <span class="text-sm font-semibold text-on-surface">{section.label}</span>
              </button>

              <div class="pl-8 space-y-2.5">
                {#each section.roles as role (role.key)}
                  {@render optionRow(role, m.st_roles_title())}
                {/each}

                {#each section.loose as channel (channel.key)}
                  {@render optionRow(channel, null)}
                {/each}

                {#each section.categories as group (group.category.key)}
                  <div class="space-y-2">
                    <button
                      type="button"
                      onclick={() => toggleCategory(group.category.key, group.channels)}
                      disabled={selectionLocked}
                      class="flex items-center gap-2.5 w-full text-left group disabled:cursor-not-allowed"
                    >
                      <span class="w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors {isChecked(group.category.key) ? 'bg-primary/80 border-primary/80 text-on-primary' : `border-outline-variant/40 text-transparent ${checkboxHover}`}">
                        <Papicon icon="Check" size={10} />
                      </span>
                      <span class="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/50">
                        {group.category.name}
                      </span>
                    </button>

                    <div class="pl-6 space-y-1.5">
                      {#each group.channels as channel (channel.key)}
                        {@render optionRow(channel, null)}
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/each}

          <!-- Qui reçoit le rôle Membre, et quand. Un choix, pas deux cases :
               l'auto-rôle donne le rôle à l'arrivée, ce que le captcha existe
               précisément pour empêcher. -->
          {#if captchaItems.length > 0}
            <div class="px-6 py-5 space-y-3">
              <div class="space-y-0.5">
                <h4 class="text-sm font-semibold text-on-surface">{m.st_verification_title()}</h4>
                {#if hasMemberRole}
                  <p class="text-[12px] text-on-surface-variant/60">
                    {m.st_verification_hint({ role: `@${memberRole?.name ?? '-'}` })}
                  </p>
                {:else}
                  <!-- Sans rôle Membre le service ne ferme rien : il n'y a plus
                       d'accès à donner, donc plus de choix à faire. -->
                  <p class="flex items-start gap-1.5 text-[12px] text-amber-600 dark:text-amber-400">
                    <Papicon icon="AlertTriangle" size={12} class="shrink-0 mt-0.5" />
                    {m.st_verification_no_role({ role: `@${memberRole?.name ?? '-'}` })}
                  </p>
                {/if}
              </div>

              <div class="grid sm:grid-cols-2 gap-2">
                {@render verificationChoice(false, m.st_verification_autorole(), m.st_verification_autorole_desc())}
                {@render verificationChoice(true, m.st_verification_captcha(), m.st_verification_captcha_desc())}
              </div>

              {#if captchaOn}
                <ul class="pl-1 space-y-1">
                  {#each captchaItems as entry (entry.key)}
                    <li class="flex items-center gap-1.5 text-[12px] text-on-surface-variant/60">
                      <Papicon
                        icon={entry.kind === 'voice' ? 'Mic' : entry.kind === 'role' ? 'Shield' : entry.kind === 'category' ? 'ChevronDown' : 'Hash'}
                        size={11}
                        class="shrink-0 opacity-40"
                      />
                      {entry.kind === 'role' ? `@${entry.name}` : entry.name}
                    </li>
                  {/each}
                </ul>
                <p class="flex items-start gap-2 text-[12px] text-on-surface-variant/60">
                  <Papicon icon="Info" size={13} class="shrink-0 mt-0.5 opacity-60" />
                  {m.st_verification_captcha_notice()}
                </p>
              {/if}
            </div>
          {/if}

          <!-- Les modules ne sont pas des salons : ils ont leur propre bloc,
               avec ce que chacun allume et pourquoi il est deja coche. -->
          {#if moduleItems.length > 0}
            {@const allModulesOn = moduleItems.every((entry) => selection.has(entry.key))}
            <div class="px-6 py-5 space-y-3 bg-surface-container-low/20">
              <button
                type="button"
                onclick={toggleAllModules}
                disabled={selectionLocked}
                class="flex items-center gap-3 w-full text-left group disabled:cursor-not-allowed"
              >
                <span class="w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors {allModulesOn ? 'bg-primary border-primary text-on-primary' : selectedModules.length > 0 ? 'border-primary text-primary' : `border-outline-variant/40 text-transparent ${checkboxHover}`}">
                  {#if allModulesOn}
                    <Papicon icon="Check" size={12} />
                  {:else if selectedModules.length > 0}
                    <span class="w-2 h-0.5 rounded-full bg-primary"></span>
                  {/if}
                </span>
                <span class="min-w-0">
                  <span class="block text-sm font-semibold text-on-surface">{m.st_modules_title()}</span>
                  <span class="block text-[12px] text-on-surface-variant/60">{m.st_modules_hint()}</span>
                </span>
              </button>

              <div class="pl-8 space-y-2">
                {#each moduleItems as mod (mod.key)}
                  {@const linkName = moduleLinkName(mod)}
                  {@const desc = moduleDesc(mod)}
                  <button
                    type="button"
                    onclick={() => toggleItem(mod)}
                    disabled={selectionLocked}
                    class="flex items-start gap-2.5 w-full text-left group disabled:cursor-not-allowed"
                  >
                    <span class="mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors {isChecked(mod.key) ? 'bg-primary border-primary text-on-primary' : `border-outline-variant/40 text-transparent ${checkboxHover}`}">
                      <Papicon icon="Check" size={10} />
                    </span>
                    <span class="min-w-0 space-y-0.5">
                      <span class="flex items-center gap-1.5 text-[13px] font-medium text-on-surface">
                        <Papicon icon="Package" size={12} class="shrink-0 opacity-40" />
                        {moduleName(mod)}
                      </span>
                      {#if desc}
                        <span class="block text-[12px] text-on-surface-variant/55">{desc}</span>
                      {/if}
                      {#if linkName}
                        <span class="block text-[12px] text-primary/80">{m.st_module_linked({ channel: `#${linkName}` })}</span>
                      {/if}
                      {#if isModuleMuted(mod)}
                        <span class="flex items-start gap-1.5 text-[12px] text-amber-600 dark:text-amber-400">
                          <Papicon icon="AlertTriangle" size={12} class="shrink-0 mt-0.5" />
                          {m.st_module_muted()}
                        </span>
                      {/if}
                    </span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </section>

      <!-- Previsualisation : la colonne de salons telle que Discord l'affiche -->
      <aside class="lg:sticky lg:top-6 space-y-4">
        <div class="space-y-0.5 px-1">
          <h3 class="text-base font-semibold text-on-surface">{m.st_preview_title()}</h3>
          <p class="text-[13px] text-on-surface-variant/60">{m.st_preview_hint()}</p>
        </div>

        <div class="rounded-xl border border-outline-variant/15 bg-surface-container-high/30 p-3 space-y-3 min-h-[200px]">
          {#if selectedCount === 0}
            <p class="text-[13px] text-on-surface-variant/50 text-center py-10">{m.st_empty_selection()}</p>
          {:else}
            <!-- Les salons hors catégorie ouvrent la colonne, comme sur Discord. -->
            {#if looseChannels.length > 0}
              <div class="space-y-0.5">
                {#each looseChannels as channel (channel.key)}
                  {@render previewChannel(channel)}
                {/each}
              </div>
            {/if}

            {#each sections as section (section.id)}
              {#each section.categories as group (group.category.key)}
                {@const visible = group.channels.filter((channel) => isChecked(channel.key))}
                {#if visible.length > 0}
                  <div class="space-y-0.5">
                    <p class="flex items-center gap-1 px-1 pt-1 text-[11px] font-bold uppercase tracking-wider text-on-surface-variant/45">
                      <Papicon icon="ChevronDown" size={10} />
                      {group.category.name}
                    </p>
                    {#each visible as channel (channel.key)}
                      {@render previewChannel(channel)}
                    {/each}
                  </div>
                {/if}
              {/each}
            {/each}

            {#if selectedRoles.length > 0}
              <div class="space-y-0.5 pt-2 border-t border-outline-variant/10">
                <p class="px-1 pt-1 text-[11px] font-bold uppercase tracking-wider text-on-surface-variant/45">
                  {m.st_roles_title()}
                </p>
                {#each selectedRoles as role (role.key)}
                  <div class="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-on-surface-variant/70">
                    <Papicon icon="Shield" size={13} class="shrink-0 opacity-60" />
                    <span class="text-[13px] font-medium truncate">@{role.name}</span>
                  </div>
                {/each}
              </div>
            {/if}

            {#if selectedModules.length > 0}
              <div class="space-y-0.5 pt-2 border-t border-outline-variant/10">
                <p class="px-1 pt-1 text-[11px] font-bold uppercase tracking-wider text-on-surface-variant/45">
                  {m.st_section_modules()}
                </p>
                {#each selectedModules as mod (mod.key)}
                  <div class="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-on-surface-variant/70">
                    <Papicon icon="Package" size={13} class="shrink-0 opacity-60" />
                    <span class="text-[13px] font-medium truncate">{moduleName(mod)}</span>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>

        <!-- Le seul element du plan qui demande une suite : le dire ici evite
             qu'on cherche son reglement dans un salon reste vide. -->
        {#if isChecked('welcome.rules')}
          <p class="flex items-start gap-2 px-1 text-[12px] text-on-surface-variant/60">
            <Papicon icon="Info" size={13} class="shrink-0 mt-0.5 opacity-60" />
            {m.st_rules_notice()}
          </p>
        {/if}

        <button
          type="button"
          onclick={handleApply}
          disabled={!canApply}
          class="w-full px-6 py-3.5 bg-primary hover:bg-primary/90 text-on-primary text-sm font-medium rounded-lg shadow-md shadow-primary/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2"
        >
          <Papicon icon="Sparkles" size={16} />
          {applyAction.state.loading ? m.st_applying() : m.st_apply()}
        </button>
        <p class="text-center text-[12px] text-on-surface-variant/50">
          {m.st_count_channels({ count: selectedChannelsCount })} · {m.st_count_roles({ count: selectedRoles.length })}
          {#if selectedModules.length > 0}
            · {m.st_modules_count({ count: selectedModules.length })}
          {/if}
        </p>
      </aside>
    </div>
  {/if}
</div>

{#snippet previewChannel(channel: ServerTemplatePlanItem)}
  {@const icon = accessIcon(channel)}
  <div class="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-on-surface-variant/70 hover:bg-surface-container-highest/40 transition-colors">
    <Papicon icon={channel.kind === 'voice' ? 'Mic' : 'Hash'} size={13} class="shrink-0 opacity-60" />
    <span class="text-[13px] font-medium truncate">{channel.name}</span>
    {#if icon}
      <span class="shrink-0 ml-auto opacity-40" title={accessLabel(channel)}>
        <Papicon {icon} size={11} />
      </span>
    {/if}
  </div>
{/snippet}

{#snippet languageChoice(code: 'fr' | 'en')}
  <!-- La langue effective est cochee, quel que soit le mode : c'est celle dans
       laquelle les salons vont etre nommes. La mention dit d'ou elle vient. -->
  {@const active = language?.locale === code}
  <button
    type="button"
    disabled={languageLoading}
    onclick={() => setLanguage({ language: code })}
    class="flex items-start gap-2.5 text-left px-3.5 py-3 rounded-lg border transition-colors disabled:cursor-not-allowed {active ? 'border-primary bg-primary/5' : `border-outline-variant/20 ${languageHover}`}"
  >
    <span class="mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 {active ? 'border-primary' : 'border-outline-variant/40'}">
      {#if active}<span class="w-2 h-2 rounded-full bg-primary"></span>{/if}
    </span>
    <span class="min-w-0 space-y-0.5">
      <span class="block text-[13px] font-medium text-on-surface">{languageLabel(code)}</span>
      {#if active}
        <span class="block text-[12px] text-on-surface-variant/55">
          {language?.mode === 'manual' ? m.home_botlanguage_mode_manual() : m.home_botlanguage_mode_auto()}
        </span>
      {/if}
    </span>
  </button>
{/snippet}

{#snippet verificationChoice(on: boolean, name: string, desc: string)}
  <!-- Aucun des deux n'est retenu tant que le role Membre est decoche : il n'y
       a alors rien a accorder, et se dire « actif » serait faux. -->
  {@const active = hasMemberRole && captchaOn === on}
  <button
    type="button"
    onclick={() => setVerification(on)}
    disabled={selectionLocked}
    class="flex items-start gap-2.5 text-left px-3.5 py-3 rounded-lg border transition-colors disabled:cursor-not-allowed {active ? 'border-primary bg-primary/5' : `border-outline-variant/20 ${choiceHover}`}"
  >
    <span class="mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 {active ? 'border-primary' : 'border-outline-variant/40'}">
      {#if active}<span class="w-2 h-2 rounded-full bg-primary"></span>{/if}
    </span>
    <span class="min-w-0 space-y-0.5">
      <span class="block text-[13px] font-medium text-on-surface">{name}</span>
      <span class="block text-[12px] text-on-surface-variant/55">{desc}</span>
    </span>
  </button>
{/snippet}

{#snippet optionRow(item: ServerTemplatePlanItem, heading: string | null)}
  {@const wiring = wiringLabel(item)}
  {@const icon = accessIcon(item)}
  <div class="space-y-1.5">
    {#if heading}
      <p class="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/50">{heading}</p>
    {/if}
    <button
      type="button"
      onclick={() => toggleItem(item)}
      disabled={selectionLocked}
      class="flex items-start gap-2.5 w-full text-left group disabled:cursor-not-allowed"
      title={item.required ? m.st_locked_item() : ''}
    >
      <span class="mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors {isChecked(item.key) ? 'bg-primary border-primary text-on-primary' : `border-outline-variant/40 text-transparent ${checkboxHover}`}">
        <Papicon icon="Check" size={10} />
      </span>
      <span class="min-w-0 space-y-0.5">
        <span class="flex items-center gap-1.5 text-[13px] font-medium text-on-surface">
          <Papicon
            icon={item.kind === 'voice' ? 'Mic' : item.kind === 'role' ? 'Shield' : 'Hash'}
            size={12}
            class="shrink-0 opacity-40"
          />
          {item.kind === 'role' ? `@${item.name}` : item.name}
          {#if item.kind !== 'role' && icon}
            <span class="shrink-0 opacity-40" title={accessLabel(item)}>
              <Papicon {icon} size={10} />
            </span>
          {/if}
        </span>
        {#if wiring}
          <span class="block text-[12px] text-on-surface-variant/55">{wiring}</span>
        {/if}
      </span>
    </button>

    <!-- « Ce salon-la le fait deja. » Sans cette ligne, la mise en place
         recreait sous son propre nom tout ce que le serveur portait sous un
         autre - et c'est ainsi qu'un serveur se retrouvait avec deux salons de
         journalisation. -->
    {#if item.kind !== 'module' && isChecked(item.key) && !selectionLocked}
      {@const candidates = adoptCandidates(item)}
      {#if candidates.length > 0}
        <div class="pl-[26px] flex items-center gap-2">
          <select
            value={adopt[item.key] ?? ''}
            disabled={isTraced(item.key)}
            onchange={(event) => setAdopt(item.key, event.currentTarget.value)}
            class="min-w-0 flex-1 rounded-lg border border-outline-variant/30 bg-surface-container-lowest/50 px-2.5 py-1.5
                   text-[12px] text-on-surface-variant/85 disabled:opacity-50"
          >
            <option value="">Créer {item.kind === 'role' ? `@${item.name}` : item.name}</option>
            {#each candidates as candidate (candidate.id)}
              <option value={candidate.id}>Utiliser {candidate.name}</option>
            {/each}
          </select>
          {#if isTraced(item.key)}
            <span class="shrink-0 text-[11px] text-primary/70">posé par Kotbo</span>
          {:else if adopt[item.key] && template?.matches?.[item.key]?.id === adopt[item.key]}
            <span class="shrink-0 text-[11px] text-on-surface-variant/45">détecté</span>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
{/snippet}
