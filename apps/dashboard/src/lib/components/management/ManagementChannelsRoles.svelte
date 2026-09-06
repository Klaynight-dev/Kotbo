<script lang="ts">
  import { channelIconName, roleDotColor } from '../../discordVisuals';
  import Papicon from '../Papicon.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import SettingsGroup from './SettingsGroup.svelte';
  import SettingsRow from './SettingsRow.svelte';
  import { categoryIcons, categoryLabel, groupByCategory } from './ManagementAccess.svelte';
  import { m } from '../../i18n';
  import { moduleName } from '../../moduleLabels';

  let {
    features = $bindable([]),
    guildSettings = $bindable({} as any),
    availableChannels = [],
    availableVoiceChannels = [],
    availableRoles = [],
    analyticsActive = true,
  }: {
    features?: any[];
    guildSettings?: any;
    availableChannels?: any[];
    availableVoiceChannels?: any[];
    availableRoles?: any[];
    analyticsActive?: boolean;
  } = $props();

  const channelOptions = $derived(
    availableChannels.map((c) => ({ id: c.id, name: c.name, icon: channelIconName(c.type) }))
  );
  const voiceOptions = $derived(
    availableVoiceChannels.map((c) => ({ id: c.id, name: c.name, icon: channelIconName('voice') }))
  );
  const roleOptions = $derived(
    availableRoles.map((r) => ({ id: r.id, name: `@${r.name}`, color: roleDotColor(r.color) }))
  );

  const globalChannelFields = $derived([
    { key: 'logChannelId', label: m.mcr_field_log_label(), desc: m.mcr_field_log_desc() },
    { key: 'regulationChannelId', label: m.mcr_field_regulation_label(), desc: m.mcr_field_regulation_desc() },
    { key: 'meetingAnnouncementChannelId', label: m.mcr_field_meeting_announce_label(), desc: m.mcr_field_meeting_announce_desc() },
    { key: 'meetingVoiceChannelId', label: m.mcr_field_meeting_voice_label(), desc: m.mcr_field_meeting_voice_desc(), isVoice: true },
    { key: 'digestChannelId', label: m.mcr_field_digest_label(), desc: m.mcr_field_digest_desc() },
    { key: 'publicChannelId', label: m.mcr_field_public_label(), desc: m.mcr_field_public_desc() },
    { key: 'configChannelId', label: m.mcr_field_config_label(), desc: m.mcr_field_config_desc() },
    { key: 'newsChannelId', label: m.mcr_field_news_label(), desc: m.mcr_field_news_desc() },
    { key: 'dailyAlgoChannelId', label: m.mcr_field_daily_algo_label(), desc: m.mcr_field_daily_algo_desc() },
  ]);

  const globalRoleFields = $derived([
    { key: 'moderatorRoleId', label: m.mcr_role_moderator_label(), desc: m.mcr_role_moderator_desc() },
    { key: 'baseStaffRoleId', label: m.mcr_role_base_staff_label(), desc: m.mcr_role_base_staff_desc() },
    { key: 'testStaffRoleId', label: m.mcr_role_test_staff_label(), desc: m.mcr_role_test_staff_desc() },
  ]);

  /**
   * Seuls les interrupteurs qui n'appartiennent a aucun module du registre.
   * `youtubeEnabled`, `digestEnabled`, `translationEnabled`, `codePoliceEnabled`,
   * `dailyAlgoEnabled` et `analyticsEnabled` sont les colonnes miroir des modules
   * du meme nom : les exposer ici en faisait un second interrupteur, qui ecrasait
   * le premier a l'enregistrement suivant. L'activation se fait sur `/modules`.
   */
  const integrationToggles = $derived([
    { key: 'githubReleasesEnabled', label: m.mcr_toggle_github_label(), desc: m.mcr_toggle_github_desc() },
    { key: 'crossServerSanctionsEnabled', label: m.mcr_toggle_cross_server_label(), desc: m.mcr_toggle_cross_server_desc() },
  ]);

  /**
   * Fonctionnalites dont le bot lit vraiment les reglages d'alerte.
   * `notifyViaDM`, `notifyViaDiscordChannel` et `metadata.webhookUrl` n'ont
   * qu'un lecteur, `staffLeadershipService`, et il ne les consulte que pour les
   * absences. Les proposer sur les quarante-six autres lignes donnait autant de
   * reglages sans effet. Toute fonctionnalite qui apprend a les lire s'ajoute ici.
   */
  const NOTIFICATION_AWARE_FEATURES = ['absences'];

  const notificationMethods = $derived([
    { key: 'notifyViaDiscordChannel', label: m.mn_method_channel_label(), desc: m.mn_method_channel_desc() },
    { key: 'notifyViaDM', label: m.mn_method_dm_label(), desc: m.mn_method_dm_desc() },
  ]);

  function setNotificationMethod(idx: number, key: string, value: boolean) {
    features[idx][key] = value;
    features = [...features];
  }

  const groupedFeatures = $derived(groupByCategory(features));

  let expandedFeature = $state<string | null>(null);
  let query = $state('');

  const matches = (feature: any) =>
    !query || moduleName(feature.featureKey, feature.featureName).toLowerCase().includes(query.toLowerCase())
      || feature.featureKey?.toLowerCase().includes(query.toLowerCase());

  const assignedCount = (feature: any) =>
    [feature.channelId, feature.notificationRoleId].filter(Boolean).length;

  const selectClass = 'w-full md:w-72';
</script>

<div class="space-y-10">
  <SettingsGroup title={m.mcr_discord_channels()} description={m.mcr_global_settings_desc()}>
    <div class="rounded-xl border border-outline-variant/10 divide-y divide-outline-variant/10 bg-surface-container-high/10">
      {#each globalChannelFields as field}
        <SettingsRow label={field.label} description={field.desc} labelFor="channel-{field.key}">
          <SearchableSelect
            id="channel-{field.key}"
            bind:value={guildSettings[field.key]}
            options={field.isVoice ? voiceOptions : channelOptions}
            placeholder={m.mcr_none_placeholder()}
            className={selectClass}
          />
        </SettingsRow>
      {/each}
    </div>
  </SettingsGroup>

  <SettingsGroup title={m.mcr_discord_roles()}>
    <div class="rounded-xl border border-outline-variant/10 divide-y divide-outline-variant/10 bg-surface-container-high/10">
      {#each globalRoleFields as field}
        <SettingsRow label={field.label} description={field.desc} labelFor="role-{field.key}">
          <SearchableSelect
            id="role-{field.key}"
            bind:value={guildSettings[field.key]}
            options={roleOptions}
            placeholder={m.mcr_none_placeholder()}
            className={selectClass}
          />
        </SettingsRow>
      {/each}
    </div>
  </SettingsGroup>

  <SettingsGroup title={m.mcr_integrations()}>
    <div class="rounded-xl border border-outline-variant/10 divide-y divide-outline-variant/10 bg-surface-container-high/10">
      {#each integrationToggles as toggle}
        <SettingsRow label={toggle.label} description={toggle.desc}>
          <ToggleSwitch
            checked={guildSettings[toggle.key]}
            ariaLabel={toggle.label}
            onToggle={(value) => {
              guildSettings[toggle.key] = value;
              guildSettings = { ...guildSettings };
            }}
          />
        </SettingsRow>
      {/each}
    </div>

    {#if !analyticsActive}
      <div class="flex gap-3 p-4 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
        <Papicon icon="Shield" size={18} class="text-emerald-500 shrink-0 mt-0.5" />
        <div class="space-y-1">
          <p class="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{m.mcr_analytics_off_title()}</p>
          <p class="text-[11px] text-on-surface-variant/60 leading-relaxed">{m.mcr_analytics_off_desc()}</p>
          <a href="/modules" class="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">
            {m.mcr_go_to_activation()} <Papicon icon="ArrowRight" size={11} />
          </a>
        </div>
      </div>
    {/if}
  </SettingsGroup>

  <SettingsGroup title={m.mcr_per_feature_title()} description={m.mcr_per_feature_desc()}>
    {#snippet actions()}
      <label class="relative">
        <span class="sr-only">{m.ma_search_placeholder()}</span>
        <Papicon icon="MagnifyingGlass" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/40" />
        <input
          type="text"
          bind:value={query}
          placeholder={m.ma_search_placeholder()}
          class="bg-surface-container-high/40 border border-outline-variant/10 rounded-lg pl-9 pr-4 py-2 text-xs w-56 focus:ring-2 focus:ring-primary/30 transition-all outline-none"
        />
      </label>
    {/snippet}

    <div class="space-y-4">
      {#each groupedFeatures as group}
        {@const items = group.items.filter(({ feature }) => matches(feature))}
        {#if items.length > 0}
          <section class="space-y-1">
            <p class="flex items-center gap-2 px-1 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/50">
              <Papicon icon={categoryIcons[group.category] || 'Grid'} size={12} />
              {categoryLabel(group.category)}
            </p>

            <div class="rounded-xl border border-outline-variant/10 divide-y divide-outline-variant/10 overflow-hidden bg-surface-container-high/10">
              {#each items as { feature, idx } (feature.featureKey)}
                {@const expanded = expandedFeature === feature.featureKey}
                <div>
                  <button
                    type="button"
                    class="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-container-high/30 transition-colors text-left"
                    onclick={() => (expandedFeature = expanded ? null : feature.featureKey)}
                  >
                    <span class="text-sm font-medium truncate">{moduleName(feature.featureKey, feature.featureName)}</span>
                    <span class="flex items-center gap-3 shrink-0">
                      <span class="text-[11px] text-on-surface-variant/40">
                        {assignedCount(feature) > 0 ? m.mcr_assigned_count({ count: assignedCount(feature) }) : m.mcr_none_placeholder()}
                      </span>
                      <span class="transition-transform {expanded ? 'rotate-180' : ''}">
                        <Papicon icon="CaretDown" size={14} />
                      </span>
                    </span>
                  </button>

                  {#if expanded}
                    <div class="divide-y divide-outline-variant/5 border-t border-outline-variant/10">
                      <SettingsRow label={m.mcr_col_main_channel()} labelFor="feature-channel-{feature.featureKey}">
                        <SearchableSelect
                          id="feature-channel-{feature.featureKey}"
                          bind:value={features[idx].channelId}
                          options={channelOptions}
                          placeholder={m.mcr_none_placeholder()}
                          className={selectClass}
                        />
                      </SettingsRow>
                      <SettingsRow label={m.mcr_col_notif_role()} labelFor="feature-notify-{feature.featureKey}">
                        <SearchableSelect
                          id="feature-notify-{feature.featureKey}"
                          bind:value={features[idx].notificationRoleId}
                          options={roleOptions}
                          placeholder={m.mcr_none_placeholder()}
                          className={selectClass}
                        />
                      </SettingsRow>

                      {#if NOTIFICATION_AWARE_FEATURES.includes(feature.featureKey)}
                        {#each notificationMethods as method}
                          <SettingsRow label={method.label} description={method.desc}>
                            <ToggleSwitch
                              checked={features[idx][method.key]}
                              ariaLabel="{moduleName(feature.featureKey, feature.featureName)} - {method.label}"
                              onToggle={(value) => setNotificationMethod(idx, method.key, value)}
                            />
                          </SettingsRow>
                        {/each}

                        <SettingsRow
                          label={m.mn_webhook_url_label()}
                          description={m.mn_webhook_url_desc()}
                          labelFor="feature-webhook-{feature.featureKey}"
                        >
                          <input
                            id="feature-webhook-{feature.featureKey}"
                            type="url"
                            placeholder="https://discord.com/api/webhooks/..."
                            bind:value={features[idx].metadata.webhookUrl}
                            class="w-full md:w-72 bg-surface-container-high text-on-surface text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 outline-none focus:ring-2 focus:ring-primary/30 transition-all"
                          />
                        </SettingsRow>

                        {#if feature.featureKey === 'absences'}
                          <p class="px-4 py-3 text-[11px] leading-relaxed text-amber-300/80 bg-amber-500/5">
                            {m.mn_absences_note()}
                          </p>
                        {/if}
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}
      {/each}
    </div>
  </SettingsGroup>
</div>
