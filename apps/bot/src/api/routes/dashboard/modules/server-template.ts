/** Routes dashboard de la mise en place guidee du serveur. */
import prisma from '../../../../utils/db.js';
import { errorMessage } from '../../../../utils/errors.js';
import { resolveGuildLocale } from '../../../../utils/i18n.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import {
  DEFAULT_SELECTION,
  TAKEOVER_SELECTION,
  applyServerTemplate,
  assessServerMaturity,
  buildServerTemplatePlan,
  normalizeSelection,
  parseAdoptions,
  readServerTemplateRefs,
  requiredPermissionsFor,
  type AdoptableKind,
} from '../../../../services/core/serverTemplateService.js';
import {
  PROVISION_PERMISSION_LABELS,
  acquireProvisionLock,
  waitForProvisionSlot,
  missingProvisionPermissions,
  releaseProvisionLock,
  releaseProvisionSlot,
} from '../../../../services/core/channelProvisioningService.js';
import {
  isOnboardingChannelPurpose,
  parseRoleRequests,
  provisionOnboardingChannel,
  provisionOnboardingRoles,
} from '../../../../services/core/onboardingProvisioningService.js';
import { ChannelType, PermissionFlagsBits, type Guild, type GuildBasedChannel } from 'discord.js';
import { type ModuleRouteContext } from './_shared.js';

/**
 * Ce que le serveur porte deja de la maquette, et par quoi.
 *
 * Sans cette lecture, une reprise n'avait qu'une issue : ne rien poser du tout.
 * `ensureTextChannel` ne reconnait un salon existant que s'il en a l'identifiant
 * en base - ce qui est vrai d'un serveur que Kotbo a monte, jamais d'un serveur
 * arrive avec ses vingt salons et son reglement ecrit a la main. Proposer la
 * maquette complete y aurait double `#reglement`, `#bienvenue` et le reste.
 *
 * On rapproche donc chaque element du plan de ce qui existe : par identifiant
 * enregistre d'abord - c'est le seul rapprochement certain -, par nom
 * normalise ensuite.
 *
 * Le rapprochement par nom ne decide plus rien tout seul. Il tranchait sans
 * montrer : `#logs-mod` ne ressemblant pas assez a `#staff-logs`, un second
 * salon de journalisation se posait a cote du premier et l'administrateur le
 * decouvrait sur Discord. L'identifiant trouve part donc avec la clef, pour que
 * l'ecran le propose comme une suggestion a confirmer - et qu'un serveur habite
 * reponde lui-meme quel salon est quoi, au lieu de se faire deviner.
 *
 * Les modules n'y figurent jamais : ils n'ecrivent rien sur Discord, il n'y a
 * donc rien a y reconnaitre.
 */
type TemplateMatch = {
  id: string;
  name: string;
  /**
   * `ref` : identifiant enregistre, rapprochement certain, la ligne peut se
   * verrouiller. `name` : devine, la ligne se pre-remplit mais reste ouverte.
   */
  source: 'ref' | 'name';
};

/**
 * Minuscules, accents retires, emoji et ponctuation de decoration enleves :
 * « 📜・Règlement » et « reglement » designent le meme salon, et c'est
 * exactement le cas ou une reprise doit s'abstenir.
 */
function normalizeLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function detectExistingMatches(
  guild: Guild,
  plan: ReturnType<typeof buildServerTemplatePlan>,
  knownRefs: Record<string, string>,
): Record<string, TemplateMatch> {
  const channelsByName = new Map<string, GuildBasedChannel>();
  for (const channel of guild.channels.cache.values()) {
    const key = normalizeLabel(channel.name);
    // Le premier trouve gagne : deux salons homonymes sont deja un probleme du
    // serveur, en ajouter un troisieme ne le reglerait pas.
    if (!channelsByName.has(key)) channelsByName.set(key, channel);
  }

  const rolesByName = new Map<string, { id: string; name: string }>();
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id) continue; // @everyone n'est la maquette de personne
    const key = normalizeLabel(role.name);
    if (!rolesByName.has(key)) rolesByName.set(key, { id: role.id, name: role.name });
  }

  const matches: Record<string, TemplateMatch> = {};

  for (const item of plan) {
    if (item.kind === 'module') continue;

    const knownId = knownRefs[item.key];
    if (knownId) {
      const found = item.kind === 'role'
        ? guild.roles.cache.get(knownId)
        : guild.channels.cache.get(knownId);
      if (found) {
        matches[item.key] = { id: found.id, name: found.name, source: 'ref' };
        continue;
      }
    }

    if (item.kind === 'role') {
      const role = rolesByName.get(normalizeLabel(item.name));
      if (role) matches[item.key] = { id: role.id, name: role.name, source: 'name' };
      continue;
    }

    const channel = channelsByName.get(normalizeLabel(item.name));
    if (!channel) continue;

    // Le type doit concorder : un salon vocal nomme « general » ne dispense pas
    // de creer le salon textuel du meme nom, et une categorie encore moins.
    const compatible =
      item.kind === 'category'
        ? channel.type === ChannelType.GuildCategory
        : item.kind === 'voice'
          ? channel.type === ChannelType.GuildVoice
          : channel.isTextBased() && !channel.isThread();

    if (compatible) matches[item.key] = { id: channel.id, name: channel.name, source: 'name' };
  }

  return matches;
}

/**
 * Les salons et roles reels du serveur, pour que l'ecran puisse demander lequel
 * joue quoi.
 *
 * C'est la matiere des menus « utiliser un salon existant ». Sans elle, la page
 * n'aurait a proposer que la creation, et l'administrateur d'un serveur monte
 * de longue date n'aurait aucun moyen de dire que son `#journal` tient deja le
 * role du salon de journalisation.
 *
 * Bornee : un serveur peut porter cinq cents salons, et la reponse voyage a
 * chaque ouverture du parcours. Au-dela, les menus deviennent de toute facon
 * inutilisables et c'est la recherche qui sert.
 */
const INVENTORY_CHANNEL_LIMIT = 500;
const INVENTORY_ROLE_LIMIT = 250;

function buildGuildInventory(guild: Guild, botHighestPosition: number) {
  const channels = [...guild.channels.cache.values()]
    .filter((channel) =>
      channel.type === ChannelType.GuildCategory
      || channel.type === ChannelType.GuildVoice
      || (channel.isTextBased() && !channel.isThread()),
    )
    .slice(0, INVENTORY_CHANNEL_LIMIT)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      kind: channel.type === ChannelType.GuildCategory
        ? ('category' as const)
        : channel.type === ChannelType.GuildVoice
          ? ('voice' as const)
          : ('text' as const),
      parentId: 'parentId' in channel ? channel.parentId ?? null : null,
      position: 'rawPosition' in channel ? channel.rawPosition : 0,
    }))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .slice(0, INVENTORY_ROLE_LIMIT)
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.hexColor,
      position: role.position,
      /**
       * Un role gere par une integration ne s'attribue pas, et un role plus
       * haut que celui du bot ne se donne pas non plus. Les proposer quand meme
       * - grises - vaut mieux que de les cacher : l'administrateur cherchait
       * son role « Membre », et ne pas le voir du tout ne lui dit pas pourquoi.
       */
      assignable: !role.managed && role.position < botHighestPosition,
      managed: role.managed,
    }))
    .sort((a, b) => b.position - a.position);

  return { channels, roles };
}

/**
 * Ce qu'un identifiant designe reellement sur ce serveur.
 *
 * Tout salon ou le bot peut ecrire compte pour `text`, pas seulement un salon
 * textuel : un salon d'annonces est un choix legitime pour un reglement, et
 * exiger le type exact reviendrait a en creer un doublon a cote. `@everyone` ne
 * designe rien - il est la maquette de personne, et l'adopter comme role Membre
 * ouvrirait a tout le monde des salons qui ne le devraient pas.
 */
function adoptableKind(guild: Guild) {
  return (id: string): AdoptableKind | null => {
    if (id !== guild.id && guild.roles.cache.has(id)) return 'role';

    const channel = guild.channels.cache.get(id);
    if (!channel) return null;
    if (channel.type === ChannelType.GuildCategory) return 'category';
    if (channel.type === ChannelType.GuildVoice) return 'voice';
    return channel.isTextBased() && !channel.isThread() ? 'text' : null;
  };
}

export async function handleServerTemplateRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, access, method, auditUser, user, moduleKey } = ctx;
  if (moduleKey !== 'server-template') return false;

  // Elle cree des salons, des roles, et ne se lance qu'une fois : elle n'a rien
  // a faire dans les mains d'un moderateur.
  if (access.level !== 'admin') {
    json(res, 403, { error: 'Seuls les administrateurs peuvent mettre le serveur en place.' });
    return true;
  }

  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) {
    json(res, 404, { error: 'Serveur Discord introuvable.' });
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/server-template
  if (parts.length === 5 && method === 'GET') {
    try {
      // Les noms sont rendus dans la langue du serveur, pas dans celle du
      // dashboard : la previsualisation doit montrer ce qui sera reellement
      // ecrit sur Discord.
      const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
      const guildRow = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          serverTemplateAppliedAt: true,
          serverTemplateAppliedBy: true,
          serverTemplateSections: true,
          serverTemplateRefs: true,
          logChannelId: true,
        },
      });

      // Mesurees sur le plan complet : ce sont celles qu'il faut pour tout
      // creer. Une selection reduite peut en demander moins, la page ne bloque
      // donc que sur `canCreateChannels`, sans quoi rien n'est possible.
      const missing = await missingProvisionPermissions(discordGuild, requiredPermissionsFor(DEFAULT_SELECTION))
        .catch(() => [PROVISION_PERMISSION_LABELS[String(PermissionFlagsBits.ManageChannels)]]);
      const me = discordGuild.members.me ?? await discordGuild.members.fetchMe().catch(() => null);

      const maturity = assessServerMaturity({
        createdAt: discordGuild.createdAt,
        memberCount: discordGuild.memberCount,
        channelCount: discordGuild.channels.cache.size,
        // `@everyone` existe sur tous les serveurs et ne prouve rien.
        roleCount: Math.max(0, discordGuild.roles.cache.size - 1),
      });

      const plan = buildServerTemplatePlan(locale);
      const knownRefs =
        guildRow?.serverTemplateRefs && typeof guildRow.serverTemplateRefs === 'object'
          && !Array.isArray(guildRow.serverTemplateRefs)
          ? (guildRow.serverTemplateRefs as Record<string, string>)
          : {};

      const matches = detectExistingMatches(discordGuild, plan, knownRefs);
      const planKeys = new Set(plan.filter((entry) => entry.kind !== 'module').map((entry) => entry.key));
      const matchedIds = new Set(Object.values(matches).map((match) => match.id));

      /**
       * Le serveur porte-t-il deja quelque chose qui lui est propre ?
       *
       * C'est ce qui decide du parcours detaille - dire quel salon est quoi,
       * section par section - plutot que de la pose directe. La question posee a
       * l'ecran precedent ne suffit pas a en decider : on repond « nouveau
       * serveur » parce que Kotbo est nouveau pour soi, et l'on se retrouve avec
       * un second `#reglement` a cote de celui qu'on avait ecrit a la main. On
       * lit donc les faits.
       *
       * Deux signaux, l'un ou l'autre : un element du plan deja reconnu, ou des
       * salons en nombre que Kotbo n'a pas poses. Un serveur strictement neuf
       * n'en declenche aucun et garde la pose directe, qui est ce qu'il lui
       * faut.
       */
      const unknownChannels = discordGuild.channels.cache.filter(
        (channel) => !matchedIds.has(channel.id) && channel.type !== ChannelType.GuildCategory,
      ).size;
      const structured = Object.keys(matches).length > 0 || unknownChannels > 3;

      json(res, 200, {
        locale,
        plan,
        // Ce que le serveur porte deja, pour qu'une reprise complete au lieu de
        // doubler. Vide sur un serveur neuf, ce qui est le cas le plus courant.
        present: Object.keys(matches).filter((key) => planKeys.has(key)),
        /**
         * Le meme constat, avec ce qui l'a produit : quel salon, quel role, et
         * si le rapprochement est certain ou devine. C'est ce qui permet a
         * l'ecran de pre-remplir une suggestion au lieu de trancher tout seul.
         */
        matches,
        /** Les salons et roles reels, matiere des menus « utiliser l'existant ». */
        inventory: buildGuildInventory(discordGuild, me?.roles.highest.position ?? 0),
        /** Serveur deja habite : le parcours detaille prend la main. */
        structured,
        // Sur un serveur habite, on ne propose que ce qui n'ecrit rien sur
        // Discord : la maquette complete y doublerait des salons utilises.
        defaultSelection: maturity.maturity === 'established' ? TAKEOVER_SELECTION : DEFAULT_SELECTION,
        missingPermissions: missing,
        canCreateChannels: me?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false,
        // Sert de repli au salon d'alerte de la sante des salons : la page ne
        // met en garde que si ce repli n'existe pas non plus.
        hasLogChannel: !!guildRow?.logChannelId,
        isAdministrator: me?.permissions.has(PermissionFlagsBits.Administrator) ?? false,
        // Serveur neuf a batir ou serveur habite a reprendre. La page l'affiche
        // avec ses motifs : la detection se trompera parfois, et une
        // recommandation dont on ne voit pas la raison se fait ignorer.
        maturity,
        /** Maquette complete, pour le bouton « tout cocher » d'une reprise. */
        fullSelection: DEFAULT_SELECTION,
        applied: guildRow?.serverTemplateAppliedAt
          ? {
              at: guildRow.serverTemplateAppliedAt.toISOString(),
              by: guildRow.serverTemplateAppliedBy,
              selection: guildRow.serverTemplateSections,
            }
          : null,
      });
    } catch (err) {
      logger.error('ServerTemplateAPI', `Error reading template plan: ${errorMessage(err)}`);
      json(res, 500, { error: 'Erreur lors de la lecture du plan de mise en place.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/server-template/apply
  if (parts.length === 6 && parts[5] === 'apply' && method === 'POST') {
    const lockKey = `server-template:${guildId}`;
    if (!acquireProvisionLock(lockKey)) {
      json(res, 409, { error: 'Une mise en place est déjà en cours sur ce serveur.' });
      return true;
    }

    // Le verrou ci-dessus ne vaut que pour ce serveur. Celui-ci borne le total :
    // une vingtaine d'appels REST par mise en place, tous derriere le meme
    // plafond global de discord.js, et trop de serveurs a la fois laisseraient
    // chaque requete pendre jusqu'a expirer.
    //
    // L'attente est prise en charge ici : la mise en place ne se lancant qu'une
    // fois par serveur, deux appels simultanes viennent de deux serveurs
    // differents et sont l'un comme l'autre legitimes. Le refus n'arrive qu'au
    // bout d'une minute d'attente, ou si la file est deja pleine.
    if (!(await waitForProvisionSlot())) {
      releaseProvisionLock(lockKey);
      json(res, 429, { error: "Trop de mises en place en cours en ce moment. Réessayez dans quelques minutes." });
      return true;
    }

    try {
      const guildRow = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { serverTemplateAppliedAt: true, serverTemplateAppliedBy: true, serverTemplateRefs: true },
      });

      const body = await readJsonBody<{ selection?: unknown; adopt?: unknown }>(req);
      const requested = Array.isArray(body?.selection)
        ? body.selection.filter((key): key is string => typeof key === 'string')
        : DEFAULT_SELECTION;
      const selection = normalizeSelection(requested);
      if (selection.length === 0) {
        json(res, 400, { error: 'Aucun élément sélectionné.' });
        return true;
      }

      /**
       * Ce que l'administrateur a designe lui-meme : « ce salon-la tient deja ce
       * role ».
       *
       * C'est la reponse au vrai defaut de la reprise. La pose ne reconnaissait
       * un salon que par son identifiant en base ou par la ressemblance de son
       * nom ; tout le reste passait pour absent et se recreait a cote. Un
       * identifiant depose ici entre dans la trace avant que la pose commence,
       * et `ensureTextChannel` le reprend alors tel quel - sans le renommer,
       * sans le deplacer, sans toucher a ses permissions.
       *
       * Le corps de requete n'est pas cru sur parole : chaque identifiant doit
       * designer un element qui existe sur ce serveur et dont la nature
       * correspond a la clef du plan. Un salon vocal envoye pour `welcome.rules`
       * poserait un reglement que personne ne peut lire.
       */
      const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
      const plan = buildServerTemplatePlan(locale);
      const planByKey = new Map(plan.map((entry) => [entry.key, entry]));
      const { adopt, rejected } = parseAdoptions(body?.adopt, adoptableKind(discordGuild), locale);

      if (rejected.length > 0) {
        json(res, 400, {
          error: `Ces éléments ne correspondent à rien d'utilisable sur le serveur : ${rejected.join(', ')}. Rechargez la page, le serveur a peut-être changé depuis.`,
        });
        return true;
      }

      /**
       * Une pose deja faite ne bloque plus, elle se complete.
       *
       * Le verrou etait la pour empecher de doubler la maquette entiere, et il
       * le faisait au prix d'un cul-de-sac : un serveur ou la pose s'etait
       * arretee a mi-chemin, ou qui a gagne un salon de tickets depuis, n'avait
       * plus aucun moyen de finir sans passer par le support. Ce qui existe est
       * desormais reconnu ligne a ligne - par la trace, ou parce que
       * l'administrateur vient de le designer - donc rejouer ne cree que ce qui
       * manque encore. Ne restent bloquees que les selections qui pretendent
       * creer quelque chose dont on n'a ni trace ni designation.
       */
      if (guildRow?.serverTemplateAppliedAt) {
        const known = { ...readServerTemplateRefs(guildRow.serverTemplateRefs), ...adopt };
        const unaccounted = selection.filter((key) => {
          const item = planByKey.get(key);
          if (!item || item.kind === 'module') return false;
          const id = known[key];
          if (!id) return true;
          return item.kind === 'role'
            ? !discordGuild.roles.cache.has(id)
            : !discordGuild.channels.cache.has(id);
        });
        if (unaccounted.length > 0 && !Array.isArray(body?.selection)) {
          json(res, 409, {
            error: `La mise en place a déjà été faite par ${guildRow.serverTemplateAppliedBy ?? 'un administrateur'}. Reprenez-la depuis le parcours de configuration pour ne compléter que ce qui manque.`,
            appliedAt: guildRow.serverTemplateAppliedAt.toISOString(),
          });
          return true;
        }
      }

      const missing = await missingProvisionPermissions(discordGuild, requiredPermissionsFor(selection));
      if (missing.length > 0) {
        json(res, 400, { error: `Kotbo n'a pas les permissions nécessaires : ${missing.join(', ')}.` });
        return true;
      }

      // La mise en place est souvent le premier geste sur un serveur neuf : la
      // ligne peut ne pas encore exister, et tout l'enregistrement au fil de
      // l'eau passe par des `update`.
      await prisma.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } });

      const result = await applyServerTemplate({ guild: discordGuild, locale, selection, adopt, auditUser });

      const created = result.items.filter((entry) => entry.created);
      // Le verrou ne se pose que sur une mise en place allee au bout et qui a
      // cree quelque chose. Une tentative sans effet, ou interrompue a
      // mi-chemin, doit pouvoir etre relancee tout de suite : les identifiants
      // deja enregistres garantissent que la reprise ne doublera rien, et
      // condamner le serveur a un passage par le panneau d'administration pour
      // une coupure reseau serait disproportionne.
      if (created.length > 0 && !result.interrupted) {
        await prisma.guild.update({
          where: { id: guildId },
          data: {
            serverTemplateAppliedAt: new Date(),
            serverTemplateAppliedBy: user.username ?? auditUser,
            serverTemplateSections: selection,
          },
        });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise en place du serveur',
        context: getGuildName(client, guildId),
        module: 'Configuration',
        eventType: 'Manuel',
        details: `Créés : ${created.map((entry) => entry.name).join(', ') || 'aucun'}. Repris : ${result.items.filter((entry) => !entry.created).map((entry) => entry.name).join(', ') || 'aucun'}. Modules activés : ${result.modules.join(', ') || 'aucun'}.${result.preparedModules.length ? ` Préparés, en attente d'abonnement : ${result.preparedModules.join(', ')}.` : ''}${result.warnings.length ? ` Avertissements : ${result.warnings.join(' | ')}` : ''}${result.interrupted ? ` Interrompu : ${result.interrupted}` : ''}`,
        channelId: null,
      });

      if (result.interrupted) {
        json(res, 500, {
          error: `Mise en place interrompue : ${result.interrupted}`,
          items: result.items,
          modules: result.modules,
          preparedModules: result.preparedModules,
          warnings: result.warnings,
          panelSent: result.panelSent,
        });
        return true;
      }

      json(res, 200, {
        success: true,
        items: result.items,
        modules: result.modules,
        preparedModules: result.preparedModules,
        warnings: result.warnings,
        panelSent: result.panelSent,
      });
    } catch (err) {
      logger.error('ServerTemplateAPI', `Error applying server template: ${errorMessage(err)}`);
      json(res, 500, { error: `Mise en place interrompue : ${errorMessage(err)}` });
    } finally {
      releaseProvisionSlot();
      releaseProvisionLock(lockKey);
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/server-template/channel
  //
  // Le parcours demande de designer un salon ; le serveur n'en a pas. Plutot
  // que de renvoyer l'administrateur creer un `#log` sur Discord et revenir
  // rafraichir la page, on le pose ici et l'ecran le selectionne dans la
  // foulee.
  if (parts.length === 6 && parts[5] === 'channel' && method === 'POST') {
    const lockKey = `onboarding-channel:${guildId}`;
    if (!acquireProvisionLock(lockKey)) {
      json(res, 409, { error: 'Un salon est déjà en cours de création sur ce serveur.' });
      return true;
    }

    try {
      const body = await readJsonBody<{ purpose?: unknown; name?: unknown }>(req);
      if (!isOnboardingChannelPurpose(body?.purpose)) {
        json(res, 400, { error: 'Usage de salon inconnu.' });
        return true;
      }

      const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
      // Premier geste possible sur un serveur neuf : la ligne peut ne pas
      // exister encore, et la trace des elements poses s'ecrit par `update`.
      await prisma.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } });

      const channel = await provisionOnboardingChannel({
        guild: discordGuild,
        locale,
        purpose: body.purpose,
        name: body.name,
        auditUser,
      });

      if (channel.created) {
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Salon créé depuis la configuration',
          context: getGuildName(client, guildId),
          module: 'Configuration',
          eventType: 'Manuel',
          details: `#${channel.name}`,
          channelId: channel.id,
        });
      }

      json(res, 200, channel);
    } catch (err) {
      logger.error('ServerTemplateAPI', `Error creating onboarding channel: ${errorMessage(err)}`);
      json(res, 500, { error: errorMessage(err) || "Le salon n'a pas pu être créé." });
    } finally {
      releaseProvisionLock(lockKey);
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/server-template/roles
  //
  // Une hierarchie de staff, ou une echelle de roles de niveau. Les deux
  // ecrans en ont besoin et demandent la meme chose : quelques roles, dans un
  // ordre, avec des pouvoirs choisis dans une liste fermee cote serveur.
  if (parts.length === 6 && parts[5] === 'roles' && method === 'POST') {
    const lockKey = `onboarding-roles:${guildId}`;
    if (!acquireProvisionLock(lockKey)) {
      json(res, 409, { error: 'Des rôles sont déjà en cours de création sur ce serveur.' });
      return true;
    }

    try {
      const body = await readJsonBody<{ roles?: unknown }>(req);
      const roles = parseRoleRequests(body?.roles);
      if (roles.length === 0) {
        json(res, 400, { error: 'Aucun rôle à créer.' });
        return true;
      }

      const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
      await prisma.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } });

      const result = await provisionOnboardingRoles({
        guild: discordGuild,
        locale,
        roles,
        auditUser,
      });

      const created = result.roles.filter((entry) => entry.created);
      if (created.length > 0) {
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Rôles créés depuis la configuration',
          context: getGuildName(client, guildId),
          module: 'Configuration',
          eventType: 'Manuel',
          details: created.map((entry) => entry.name).join(', '),
          channelId: null,
        });
      }

      json(res, 200, result);
    } catch (err) {
      logger.error('ServerTemplateAPI', `Error creating onboarding roles: ${errorMessage(err)}`);
      json(res, 500, { error: errorMessage(err) || "Les rôles n'ont pas pu être créés." });
    } finally {
      releaseProvisionLock(lockKey);
    }
    return true;
  }

  return false;
}
