/**
 * Prereglages de sante des salons : les seuils bougent toujours ensemble, un
 * serveur etant soit indulgent soit severe. Un prereglage pose ce curseur d'un
 * coup, fenetre d'analyse comprise : plus on veut reagir vite, plus elle est
 * courte, et plus une baisse passagere suffit a declencher une alerte.
 *
 * Un prereglage ne touche ni aux modes de decoupage et d'archivage, ni au
 * digest hebdomadaire : laisser le bot agir seul est une question de confiance,
 * pas de sensibilite, et un prereglage n'a aucun moyen de la deviner.
 */

export type ChannelHealthPresetValues = {
  analysisPeriodDays: number;
  /**
   * Malgre son nom, le service compare ce seuil a la moyenne quotidienne
   * (`avgMsgPerHour >= overloadMsgPerHour / 24`) : il se lit en messages par
   * jour. Les tuiles l'affichent dans cette unite, sans quoi les prereglages
   * annonceraient des volumes vingt-quatre fois trop petits.
   */
  overloadMsgPerHour: number;
  overloadUniqueUsers: number;
  underusedMsgPerDay: number;
  underusedUniqueUsers: number;
  deadMsgPerWeek: number;
};

export type ChannelHealthPreset = {
  id: string;
  icon: string;
  values: ChannelHealthPresetValues;
  /** Mis en avant dans la grille : ce sont les seuils par defaut du module. */
  recommended?: boolean;
};

export const CHANNEL_HEALTH_PRESET_FIELDS = [
  'analysisPeriodDays',
  'overloadMsgPerHour',
  'overloadUniqueUsers',
  'underusedMsgPerDay',
  'underusedUniqueUsers',
  'deadMsgPerWeek',
] as const satisfies readonly (keyof ChannelHealthPresetValues)[];

/** Reprend les defauts de `ChannelHealthConfig` en base. */
const BALANCED_VALUES: ChannelHealthPresetValues = {
  analysisPeriodDays: 14,
  overloadMsgPerHour: 120,
  overloadUniqueUsers: 80,
  underusedMsgPerDay: 5,
  underusedUniqueUsers: 3,
  deadMsgPerWeek: 2,
};

export const CHANNEL_HEALTH_PRESETS: readonly ChannelHealthPreset[] = [
  {
    id: 'lenient',
    icon: 'moon',
    values: {
      analysisPeriodDays: 30,
      overloadMsgPerHour: 200,
      overloadUniqueUsers: 120,
      underusedMsgPerDay: 2,
      underusedUniqueUsers: 2,
      deadMsgPerWeek: 1,
    },
  },
  {
    id: 'balanced',
    icon: 'Star',
    recommended: true,
    values: BALANCED_VALUES,
  },
  {
    id: 'strict',
    // En kebab-case : `toPapiconsName` minuscule l'interieur de chaque partie,
    // « AlertTriangle » deviendrait « Alerttriangle » et tomberait sur l'icone
    // de secours.
    icon: 'alert-triangle',
    values: {
      analysisPeriodDays: 7,
      overloadMsgPerHour: 60,
      overloadUniqueUsers: 40,
      underusedMsgPerDay: 10,
      underusedUniqueUsers: 5,
      deadMsgPerWeek: 5,
    },
  },
];

/**
 * Valeurs de depart d'un serveur qui n'a jamais configure le module : la page
 * ne doit pas proposer une configuration initiale que le bot contredirait au
 * premier enregistrement.
 */
export const CHANNEL_HEALTH_DEFAULT_CONFIG = {
  enabled: true,
  splitMode: 'NOTIFY',
  archiveMode: 'NOTIFY',
  weeklyDigestEnabled: true,
  weeklyDigestDay: 1,
  excludedChannelIds: [] as string[],
  ...BALANCED_VALUES,
};

/** Champs que la page modifie, et les seuls a comparer pour la dire modifiee. */
export const CHANNEL_HEALTH_EDITABLE_FIELDS = [
  'enabled',
  'splitMode',
  'archiveMode',
  'weeklyDigestEnabled',
  'weeklyDigestDay',
  ...CHANNEL_HEALTH_PRESET_FIELDS,
] as const satisfies readonly (keyof typeof CHANNEL_HEALTH_DEFAULT_CONFIG)[];

/** Ne retient d'une configuration que les champs qu'un prereglage pose. */
export function channelHealthValuesOf(source: any): ChannelHealthPresetValues | null {
  if (!source) return null;
  const values = {} as ChannelHealthPresetValues;
  for (const key of CHANNEL_HEALTH_PRESET_FIELDS) values[key] = source[key];
  return values;
}

export function matchesChannelHealthPreset(
  preset: ChannelHealthPreset,
  config: Partial<ChannelHealthPresetValues> | null | undefined,
): boolean {
  if (!config) return false;
  return CHANNEL_HEALTH_PRESET_FIELDS.every((key) => preset.values[key] === config[key]);
}

export function findChannelHealthPreset(
  config: Partial<ChannelHealthPresetValues> | null | undefined,
): ChannelHealthPreset | null {
  return CHANNEL_HEALTH_PRESETS.find((preset) => matchesChannelHealthPreset(preset, config)) ?? null;
}
