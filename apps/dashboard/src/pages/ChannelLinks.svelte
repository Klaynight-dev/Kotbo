<script lang="ts">
  import { m } from '../lib/i18n';
  import { onMount } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import {
    fetchChannelLinks,
    fetchChannelLinkOtherGuilds,
    createDirectChannelLink,
    generateChannelLinkInvite,
    updateChannelLink,
    deleteChannelLink,
    addChannelLinkMember,
    updateChannelLinkMember,
    removeChannelLinkMember,
  } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import Modal from '../lib/components/Modal.svelte';

  let groups = $state<any[]>([]);
  let loading = $state(true);

  // Other guilds for direct linking
  let otherGuilds = $state<any[]>([]);
  let loadingGuilds = $state(false);

  // Create group modal
  let showCreateModal = $state(false);
  let newSourceChannelId = $state('');
  let newGroupName = $state('');
  let newTargets = $state<{ guildId: string; channelId: string }[]>([]);
  let newOwnerMode = $state('BOTH');
  let newRelayMode = $state('WEBHOOK');
  let newCreateServerInvite = $state(false);
  let createdInviteUrl = $state<string | null>(null);

  // Config modal
  let showConfigModal = $state(false);
  let configGroup = $state<any>(null);
  let configInviteUrl = $state<string | null>(null);
  let generatingInvite = $state(false);

  // Ajout d'un salon à un pont existant
  let addGuildId = $state('');
  let addChannelId = $state('');
  let addMode = $state('BOTH');
  let addingMember = $state(false);

  // Delete confirm
  let showDeleteModal = $state(false);
  let deleteTargetId = $state('');

  const saveAction = createAsyncActionState();

  const channels = $derived(dashboardStore.state.discordChannels ?? []);

  function guildChannels(guildId: string) {
    return otherGuilds.find((g: any) => g.id === guildId)?.channels ?? [];
  }

  const addGuildChannels = $derived.by(() => {
    const taken = new Set((configGroup?.members ?? []).filter((mb: any) => mb.guildId === addGuildId).map((mb: any) => mb.channelId));
    return guildChannels(addGuildId).filter((c: any) => !taken.has(c.id));
  });

  async function loadData() {
    loading = true;
    try {
      groups = (await fetchChannelLinks()) ?? [];
      if (configGroup) {
        configGroup = groups.find((g: any) => g.id === configGroup.id) ?? null;
        if (!configGroup) showConfigModal = false;
      }
    } catch (err) {
      toast.error(m.channel_links_load_error());
    } finally {
      loading = false;
    }
  }

  async function loadOtherGuilds() {
    loadingGuilds = true;
    try {
      otherGuilds = (await fetchChannelLinkOtherGuilds()) ?? [];
    } catch (err) {
      toast.error(m.channel_links_load_guilds_error());
    } finally {
      loadingGuilds = false;
    }
  }

  onMount(() => {
    dashboardStore.refresh();
    loadData();
    // Prechargement : la liste n'etait demandee qu'a l'ouverture de la modale,
    // ou l'utilisateur attendait le spinner. Elle arrive maintenant pendant
    // qu'il lit la page. openCreateModal garde son garde-fou si l'appel echoue.
    loadOtherGuilds();
  });

  function openCreateModal() {
    newSourceChannelId = '';
    newGroupName = '';
    newTargets = [];
    newOwnerMode = 'BOTH';
    newRelayMode = 'WEBHOOK';
    newCreateServerInvite = false;
    createdInviteUrl = null;
    showCreateModal = true;
    if (otherGuilds.length === 0) loadOtherGuilds();
  }

  function toggleTargetGuild(guildId: string) {
    const existing = newTargets.find((t) => t.guildId === guildId);
    newTargets = existing
      ? newTargets.filter((t) => t.guildId !== guildId)
      : [...newTargets, { guildId, channelId: '' }];
  }

  function setTargetChannel(guildId: string, channelId: string) {
    newTargets = newTargets.map((t) => (t.guildId === guildId ? { ...t, channelId } : t));
  }

  async function handleCreateDirect() {
    if (!newSourceChannelId) {
      toast.error(m.channel_links_err_source_required());
      return;
    }
    if (newTargets.length === 0 || newTargets.some((t) => !t.channelId)) {
      toast.error(m.channel_links_err_target_required());
      return;
    }
    await saveAction.run(async () => {
      const result = await createDirectChannelLink({
        sourceChannelId: newSourceChannelId,
        name: newGroupName,
        ownerMode: newOwnerMode,
        targets: newTargets.map((t) => ({
          guildId: t.guildId,
          channelId: t.channelId,
          mode: newOwnerMode === 'SEND_ONLY' ? 'RECEIVE_ONLY' : 'BOTH',
        })),
        relayMode: newRelayMode,
        createServerInvite: newCreateServerInvite,
      });
      if (result) {
        if (result.serverInviteUrl) {
          createdInviteUrl = result.serverInviteUrl;
        } else {
          showCreateModal = false;
        }
        await loadData();
        return true;
      }
      return false;
    }, { successMessage: m.channel_links_created_toast() });
  }

  async function handleToggleGroup(groupId: string, enabled: boolean) {
    await updateChannelLink(groupId, { enabled });
    await loadData();
  }

  async function handleUpdateConfig() {
    if (!configGroup) return;
    await saveAction.run(async () => {
      const updated = await updateChannelLink(configGroup.id, {
        name: configGroup.name,
        relayText: configGroup.relayText,
        relayImages: configGroup.relayImages,
        relayEmbeds: configGroup.relayEmbeds,
        relayReactions: configGroup.relayReactions,
        relayEdits: configGroup.relayEdits,
        relayDeletes: configGroup.relayDeletes,
        relayPins: configGroup.relayPins,
      });
      if (updated) {
        showConfigModal = false;
        await loadData();
        return true;
      }
      return false;
    }, { successMessage: m.channel_links_config_updated_toast() });
  }

  async function handleMemberChange(memberId: string, data: Record<string, any>) {
    if (!configGroup) return;
    const updated = await updateChannelLinkMember(configGroup.id, memberId, data);
    if (updated) {
      await loadData();
      toast.success(m.channel_links_member_updated_toast());
    }
  }

  async function handleAddMember() {
    if (!configGroup || !addGuildId || !addChannelId) {
      toast.error(m.channel_links_err_add_member());
      return;
    }
    addingMember = true;
    try {
      const updated = await addChannelLinkMember(configGroup.id, {
        guildId: addGuildId,
        channelId: addChannelId,
        mode: addMode,
      });
      if (updated) {
        addGuildId = '';
        addChannelId = '';
        addMode = 'BOTH';
        await loadData();
        toast.success(m.channel_links_member_added_toast());
      }
    } finally {
      addingMember = false;
    }
  }

  async function handleRemoveMember(memberId: string) {
    if (!configGroup) return;
    const ok = await removeChannelLinkMember(configGroup.id, memberId);
    if (ok) {
      await loadData();
      toast.success(m.channel_links_member_removed_toast());
    }
  }

  let configInviteTopicUpdated = $state(false);

  async function handleGenerateInvite(groupId: string) {
    generatingInvite = true;
    configInviteTopicUpdated = false;
    try {
      const result = await generateChannelLinkInvite(groupId);
      if (result?.inviteUrl) {
        configInviteUrl = result.inviteUrl;
        configInviteTopicUpdated = !!result.topicUpdated;
        toast.success(result.topicUpdated ? m.channel_links_invite_topic_toast() : m.channel_links_invite_generated_toast());
      }
    } catch {
      toast.error(m.channel_links_invite_gen_error());
    } finally {
      generatingInvite = false;
    }
  }

  async function handleDelete() {
    if (!deleteTargetId) return;
    const ok = await deleteChannelLink(deleteTargetId);
    if (ok) {
      showDeleteModal = false;
      await loadData();
    }
  }

  function openConfig(group: any) {
    configGroup = { ...group };
    configInviteUrl = null;
    addGuildId = '';
    addChannelId = '';
    addMode = 'BOTH';
    showConfigModal = true;
    if (otherGuilds.length === 0) loadOtherGuilds();
  }

  function confirmDelete(id: string) {
    deleteTargetId = id;
    showDeleteModal = true;
  }

  function modeLabel(mode: string) {
    if (mode === 'SEND_ONLY') return m.channel_links_member_mode_send();
    if (mode === 'RECEIVE_ONLY') return m.channel_links_member_mode_receive();
    return m.channel_links_member_mode_both();
  }

  function modeArrow(mode: string) {
    if (mode === 'SEND_ONLY') return '→';
    if (mode === 'RECEIVE_ONLY') return '←';
    return '↔';
  }

  function relayModeLabel(mode: string) {
    return mode === 'WEBHOOK' ? m.channel_links_mode_webhook() : m.channel_links_mode_embed();
  }

  function groupTitle(group: any) {
    return group.name || m.channel_links_group_default_name({ count: group.members.length });
  }

  // Les deux manques sont montrés ensemble : en corriger un pour découvrir
  // l'autre au rechargement suivant ferait perdre un aller-retour.
  function memberWarnings(member: any): string[] {
    if (member.channelMissing) return [m.channel_links_perm_channel_missing()];

    const warnings: string[] = [];
    if (member.missingEveryonePermissions?.length) {
      warnings.push(m.channel_links_perm_missing_everyone({ perms: member.missingEveryonePermissions.join(', ') }));
    }
    if (member.missingBotPermissions?.length) {
      warnings.push(m.channel_links_perm_missing_bot({ perms: member.missingBotPermissions.join(', ') }));
    }
    return warnings;
  }
</script>

<ModulePage
  title={m.channel_links_page_title()}
  description={m.channel_links_page_desc()}
  icon="link"
  featureKey="channel_links"
>
  {#snippet actions()}
    <RefreshButton onclick={loadData} />
  {/snippet}

  {#snippet children()}
    <InlineFeedback state={saveAction} />

    <div class="flex flex-col gap-6">
      <!-- Mode liaison seule : ce que les autres serveurs acceptent réellement -->
      <div class="flex gap-4 p-5 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
        <Papicon icon="shield" size={20} class="text-emerald-500 shrink-0 mt-0.5" />
        <div class="space-y-2 min-w-0">
          <h3 class="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{m.channel_links_guest_banner_title()}</h3>
          <p class="text-xs text-on-surface-variant/70 leading-relaxed">{m.channel_links_guest_banner_desc()}</p>
          <ol class="text-xs text-on-surface-variant/60 leading-relaxed list-decimal list-inside space-y-0.5">
            <li>{m.channel_links_guest_step_1()}</li>
            <li>{m.channel_links_guest_step_2()}</li>
            <li>{m.channel_links_guest_step_3()}</li>
          </ol>
        </div>
      </div>

      <!-- Actions bar -->
      <div class="flex items-center justify-between">
        <p class="text-sm text-on-surface-variant">{m.channel_links_configured_count({ count: groups.length })}</p>
        <button
          onclick={openCreateModal}
          class="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium"
        >
          <Papicon icon="plus" size={16} />
          {m.channel_links_create_btn()}
        </button>
      </div>

      <!-- Groups list -->
      {#if loading}
        <div class="flex items-center justify-center py-16">
          <div class="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full"></div>
        </div>
      {:else if groups.length === 0}
        <div class="flex flex-col items-center justify-center py-16 text-center">
          <div class="w-16 h-16 bg-surface-container-low rounded-2xl flex items-center justify-center mb-4">
            <Papicon icon="link" size={32} class="text-on-surface-variant/40" />
          </div>
          <h3 class="text-lg font-semibold text-on-surface mb-1">{m.channel_links_empty_title()}</h3>
          <p class="text-sm text-on-surface-variant/60 max-w-sm">
            {m.channel_links_empty_desc()}
          </p>
        </div>
      {:else}
        <div class="grid gap-4">
          {#each groups as group}
            <div class="bg-surface-container-low/40 rounded-xl border border-outline-variant/30 p-5 hover:border-primary/20 transition-all group">
              <div class="flex items-start justify-between gap-4">
                <!-- Left: info -->
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-3">
                    <h4 class="text-sm font-semibold text-on-surface">{groupTitle(group)}</h4>
                    <span class="text-xs text-on-surface-variant/50">
                      {m.channel_links_group_servers_count({ count: group.remoteGuildCount + 1 })}
                    </span>
                  </div>

                  <div class="flex flex-col gap-1.5 mb-3">
                    {#each group.members as member}
                      {@const warnings = memberWarnings(member)}
                      <div class="flex items-center gap-2 min-w-0">
                        {#if member.guildIcon}
                          <img src={member.guildIcon} alt="" class="w-5 h-5 rounded shrink-0" />
                        {:else}
                          <div class="w-5 h-5 rounded bg-surface-container flex items-center justify-center shrink-0">
                            <Papicon icon="server" size={11} class="text-on-surface-variant/50" />
                          </div>
                        {/if}
                        <span class="text-xs text-on-surface-variant/70 truncate">
                          {member.isLocal ? m.channel_links_this_server() : member.guildName}
                        </span>
                        <span class="text-xs font-medium text-on-surface">#{member.channelName}</span>
                        <span class="text-xs text-on-surface-variant/40" title={modeLabel(member.mode)}>{modeArrow(member.mode)}</span>
                        {#if !member.enabled}
                          <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-container text-on-surface-variant/60">
                            {m.channel_links_member_paused()}
                          </span>
                        {/if}
                        {#if member.isLinkOnly}
                          <span
                            class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                            title={m.channel_links_badge_link_only_tooltip()}
                          >
                            {m.channel_links_badge_link_only()}
                          </span>
                        {/if}
                        {#if warnings.length > 0}
                          <span
                            class="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                            title={warnings.join(' ')}
                          >
                            {m.channel_links_perm_badge()}
                          </span>
                        {/if}
                      </div>
                    {/each}
                  </div>

                  <div class="flex flex-wrap gap-1.5">
                    {#if group.relayText}<span class="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">{m.channel_links_relay_text()}</span>{/if}
                    {#if group.relayImages}<span class="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">{m.channel_links_relay_images()}</span>{/if}
                    {#if group.relayEdits}<span class="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">{m.channel_links_relay_edits()}</span>{/if}
                    {#if group.relayDeletes}<span class="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">{m.channel_links_relay_deletes()}</span>{/if}
                  </div>
                </div>

                <!-- Right: actions -->
                <div class="flex items-center gap-3">
                  <ToggleSwitch
                    checked={group.enabled}
                    onToggle={(v) => handleToggleGroup(group.id, v)}
                  />
                  <button
                    onclick={() => openConfig(group)}
                    class="p-2 rounded-lg hover:bg-surface-container transition-colors"
                    title={m.channel_links_config_tooltip()}
                  >
                    <Papicon icon="settings" size={16} class="text-on-surface-variant" />
                  </button>
                  <button
                    onclick={() => confirmDelete(group.id)}
                    class="p-2 rounded-lg hover:bg-red-500/10 transition-colors"
                    title={m.common_delete()}
                  >
                    <Papicon icon="trash-2" size={16} class="text-red-400" />
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Create Group Modal -->
    <Modal bind:open={showCreateModal} title={m.channel_links_modal_create_title()}>
      <div class="flex flex-col gap-5 p-4">
        <div>
          <label for="new-group-name" class="block text-sm font-medium text-on-surface mb-1.5">{m.channel_links_group_name_label()}</label>
          <input
            id="new-group-name"
            bind:value={newGroupName}
            placeholder={m.channel_links_group_name_ph()}
            class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
          />
        </div>

        <!-- Step 1: Source channel -->
        <div>
          <label for="new-source-channel-id" class="block text-sm font-medium text-on-surface mb-1.5">{m.channel_links_source_channel_label()}</label>
          <select
            id="new-source-channel-id"
            bind:value={newSourceChannelId}
            class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
          >
            <option value="">{m.channel_links_select_channel_ph()}</option>
            {#each channels as ch}
              <option value={ch.id}>#{ch.name}</option>
            {/each}
          </select>
        </div>

        <!-- Step 2: Target servers (plusieurs) -->
        <div>
          <span class="block text-sm font-medium text-on-surface mb-1.5">{m.channel_links_targets_label()}</span>
          <p class="text-xs text-on-surface-variant/50 mb-2">{m.channel_links_targets_hint()}</p>
          {#if loadingGuilds}
            <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30">
              <div class="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full"></div>
              <span class="text-sm text-on-surface-variant">{m.channel_links_loading_guilds()}</span>
            </div>
          {:else if otherGuilds.length === 0}
            <div class="px-3 py-3 rounded-lg bg-surface-container/40 border border-outline-variant/20 text-center">
              <p class="text-sm text-on-surface-variant/60">{m.channel_links_no_guilds_title()}</p>
              <p class="text-xs text-on-surface-variant/40 mt-1">{m.channel_links_no_guilds_desc()}</p>
            </div>
          {:else}
            <div class="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
              {#each otherGuilds as guild}
                {@const selected = newTargets.find((t) => t.guildId === guild.id)}
                <div class="rounded-lg border transition-all {selected ? 'bg-primary/10 border-primary/40' : 'bg-surface-container/40 border-outline-variant/20'}">
                  <button
                    type="button"
                    onclick={() => toggleTargetGuild(guild.id)}
                    class="flex items-center gap-3 px-3 py-2.5 text-left w-full"
                  >
                    {#if guild.icon}
                      <img src={guild.icon} alt="" class="w-8 h-8 rounded-lg shrink-0" />
                    {:else}
                      <div class="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center shrink-0">
                        <Papicon icon="server" size={16} class="text-on-surface-variant/50" />
                      </div>
                    {/if}
                    <div class="flex-1 min-w-0">
                      <p class="text-sm font-medium text-on-surface truncate">{guild.name}</p>
                      <p class="text-xs text-on-surface-variant/50">{m.channel_links_guild_channel_count({ count: guild.channels.length })}</p>
                    </div>
                    {#if selected}
                      <Papicon icon="check" size={16} class="text-primary shrink-0" />
                    {/if}
                  </button>

                  {#if selected}
                    <div class="px-3 pb-3">
                      <select
                        value={selected.channelId}
                        onchange={(e) => setTargetChannel(guild.id, (e.currentTarget as HTMLSelectElement).value)}
                        class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
                      >
                        <option value="">{m.channel_links_select_channel_ph()}</option>
                        {#each guild.channels.filter((c: any) => !(guild.id === authStore.selectedGuildId && c.id === newSourceChannelId)) as ch}
                          <option value={ch.id}>#{ch.name}</option>
                        {/each}
                      </select>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Options -->
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label for="new-owner-mode" class="block text-sm font-medium text-on-surface mb-1.5">{m.channel_links_field_member_mode()}</label>
            <select
              id="new-owner-mode"
              bind:value={newOwnerMode}
              class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
            >
              <option value="BOTH">{m.channel_links_member_mode_both()}</option>
              <option value="SEND_ONLY">{m.channel_links_member_mode_send()}</option>
              <option value="RECEIVE_ONLY">{m.channel_links_member_mode_receive()}</option>
            </select>
          </div>
          <div>
            <label for="new-relay-mode" class="block text-sm font-medium text-on-surface mb-1.5">{m.channel_links_field_relay_mode()}</label>
            <select
              id="new-relay-mode"
              bind:value={newRelayMode}
              class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
            >
              <option value="WEBHOOK">{m.channel_links_mode_webhook_mirror()}</option>
              <option value="EMBED">{m.channel_links_mode_embed()}</option>
            </select>
          </div>
        </div>

        <!-- Server invite option -->
        <div class="flex items-center justify-between px-3 py-2.5 rounded-lg bg-surface-container/40 border border-outline-variant/10">
          <div>
            <span class="text-sm text-on-surface">{m.channel_links_option_invite_title()}</span>
            <p class="text-xs text-on-surface-variant/50 mt-0.5">{m.channel_links_option_invite_desc()}</p>
          </div>
          <ToggleSwitch checked={newCreateServerInvite} onToggle={(v) => newCreateServerInvite = v} size="sm" />
        </div>

        <!-- Visual summary -->
        {#if newSourceChannelId && newTargets.length > 0 && newTargets.every((t) => t.channelId)}
          {@const sourceChannel = channels.find((c) => c.id === newSourceChannelId)}
          <div class="flex flex-wrap items-center justify-center gap-2 px-4 py-3 rounded-lg bg-primary/5 border border-primary/20">
            <span class="text-sm font-medium text-on-surface">#{sourceChannel?.name}</span>
            <span class="text-primary">{modeArrow(newOwnerMode)}</span>
            {#each newTargets as target, i}
              {@const guild = otherGuilds.find((g) => g.id === target.guildId)}
              {@const channel = guildChannels(target.guildId).find((c: any) => c.id === target.channelId)}
              <span class="text-sm font-medium text-on-surface">
                {i > 0 ? '+ ' : ''}#{channel?.name}
                <span class="text-xs text-on-surface-variant/50">({guild?.name})</span>
              </span>
            {/each}
          </div>
        {/if}

        <!-- Created invite URL result -->
        {#if createdInviteUrl}
          <div class="flex flex-col gap-2 px-4 py-3 rounded-lg bg-green-500/10 border border-green-500/30">
            <div class="flex items-center gap-2">
              <Papicon icon="check-circle" size={16} class="text-green-400" />
              <span class="text-sm font-semibold text-green-400">{m.channel_links_invite_created_badge()}</span>
            </div>
            <p class="text-xs text-on-surface-variant/70">{m.channel_links_invite_created_hint()}</p>
            <div class="flex items-center gap-2">
              <code class="flex-1 text-sm font-mono bg-surface-container px-3 py-1.5 rounded-lg text-on-surface select-all break-all">{createdInviteUrl}</code>
              <button
                type="button"
                onclick={() => { navigator.clipboard.writeText(createdInviteUrl ?? ''); toast.success(m.channel_links_link_copied()); }}
                class="p-2 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors"
                title={m.common_copy()}
              >
                <Papicon icon="copy" size={16} class="text-on-surface-variant" />
              </button>
            </div>
            <button
              onclick={() => { showCreateModal = false; createdInviteUrl = null; }}
              class="w-full mt-1 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium"
            >
              {m.common_close()}
            </button>
          </div>
        {:else}
          <button
            onclick={handleCreateDirect}
            disabled={saveAction.state.loading || !newSourceChannelId || newTargets.length === 0 || newTargets.some((t) => !t.channelId)}
            class="w-full px-4 py-2.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium disabled:opacity-50"
          >
            {saveAction.state.loading ? m.channel_links_creating() : m.channel_links_create_submit()}
          </button>
        {/if}
      </div>
    </Modal>

    <!-- Config Modal -->
    <Modal bind:open={showConfigModal} title={m.channel_links_modal_config_title()}>
      {#if configGroup}
        <div class="flex flex-col gap-5 p-4">
          <div>
            <label for="config-group-name" class="block text-sm font-medium text-on-surface mb-1.5">{m.channel_links_group_name_label()}</label>
            <input
              id="config-group-name"
              bind:value={configGroup.name}
              placeholder={m.channel_links_group_name_ph()}
              class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
            />
          </div>

          <!-- Salons du pont -->
          <div>
            <span class="block text-sm font-medium text-on-surface mb-2">{m.channel_links_members_heading()}</span>
            <div class="flex flex-col gap-2">
              {#each configGroup.members as member}
                <div class="flex flex-wrap items-center gap-2 px-3 py-2.5 rounded-lg bg-surface-container/40 border border-outline-variant/10">
                  {#if member.guildIcon}
                    <img src={member.guildIcon} alt="" class="w-6 h-6 rounded shrink-0" />
                  {:else}
                    <div class="w-6 h-6 rounded bg-surface-container flex items-center justify-center shrink-0">
                      <Papicon icon="server" size={12} class="text-on-surface-variant/50" />
                    </div>
                  {/if}
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-on-surface truncate">
                      {member.isLocal ? m.channel_links_this_server() : member.guildName}
                    </p>
                    <p class="text-xs text-on-surface-variant/50">#{member.channelName}</p>
                  </div>

                  <select
                    value={member.mode}
                    onchange={(e) => handleMemberChange(member.id, { mode: (e.currentTarget as HTMLSelectElement).value })}
                    class="px-2 py-1.5 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-xs outline-none"
                  >
                    <option value="BOTH">{m.channel_links_member_mode_both()}</option>
                    <option value="SEND_ONLY">{m.channel_links_member_mode_send()}</option>
                    <option value="RECEIVE_ONLY">{m.channel_links_member_mode_receive()}</option>
                  </select>

                  <select
                    value={member.relayMode}
                    onchange={(e) => handleMemberChange(member.id, { relayMode: (e.currentTarget as HTMLSelectElement).value })}
                    class="px-2 py-1.5 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-xs outline-none"
                    title={m.channel_links_field_relay_mode()}
                  >
                    <option value="WEBHOOK">{relayModeLabel('WEBHOOK')}</option>
                    <option value="EMBED">{relayModeLabel('EMBED')}</option>
                  </select>

                  <ToggleSwitch
                    checked={member.enabled}
                    onToggle={(v) => handleMemberChange(member.id, { enabled: v })}
                    size="sm"
                  />

                  <button
                    type="button"
                    onclick={() => handleRemoveMember(member.id)}
                    class="p-1.5 rounded-lg hover:bg-red-500/10 transition-colors"
                    title={m.channel_links_remove_member_tooltip()}
                  >
                    <Papicon icon="trash-2" size={14} class="text-red-400" />
                  </button>

                  {#each memberWarnings(member) as warning}
                    <p class="w-full text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">
                      {warning}
                    </p>
                  {/each}
                </div>
              {/each}
            </div>

            <!-- Un pont réduit à un seul salon n'a plus d'objet : le dire ici évite
                 la surprise d'un pont qui disparaît en retirant l'avant-dernier. -->
            {#if configGroup.members.length <= 2}
              <p class="mt-2 text-[11px] text-on-surface-variant/50">{m.channel_links_last_members_notice()}</p>
            {/if}

            <!-- Ajout d'un salon -->
            <div class="mt-3 flex flex-col gap-2 px-3 py-3 rounded-lg bg-surface-container/30 border border-outline-variant/10">
              <span class="text-sm font-medium text-on-surface">{m.channel_links_add_member_heading()}</span>
              <div class="grid grid-cols-2 gap-2">
                <select
                  bind:value={addGuildId}
                  onchange={() => { addChannelId = ''; }}
                  class="px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
                >
                  <option value="">{m.channel_links_select_guild_ph()}</option>
                  {#each otherGuilds as guild}
                    <option value={guild.id}>{guild.name}</option>
                  {/each}
                </select>
                <select
                  bind:value={addChannelId}
                  disabled={!addGuildId}
                  class="px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none disabled:opacity-50"
                >
                  <option value="">{m.channel_links_select_channel_ph()}</option>
                  {#each addGuildChannels as ch}
                    <option value={ch.id}>#{ch.name}</option>
                  {/each}
                </select>
              </div>
              <div class="flex items-center gap-2">
                <select
                  bind:value={addMode}
                  class="flex-1 px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
                >
                  <option value="BOTH">{m.channel_links_member_mode_both()}</option>
                  <option value="SEND_ONLY">{m.channel_links_member_mode_send()}</option>
                  <option value="RECEIVE_ONLY">{m.channel_links_member_mode_receive()}</option>
                </select>
                <button
                  type="button"
                  onclick={handleAddMember}
                  disabled={addingMember || !addGuildId || !addChannelId}
                  class="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {addingMember ? m.channel_links_adding_member() : m.channel_links_add_member_btn()}
                </button>
              </div>
            </div>
          </div>

          <div>
            <span class="block text-sm font-medium text-on-surface mb-2">{m.channel_links_relayed_content_heading()}</span>
            <div class="grid grid-cols-2 gap-3">
              {#each [
                { label: m.channel_links_relay_text(), key: 'relayText' },
                { label: m.channel_links_relay_images(), key: 'relayImages' },
                { label: m.channel_links_relay_embeds(), key: 'relayEmbeds' },
                { label: m.channel_links_relay_reactions(), key: 'relayReactions' },
                { label: m.channel_links_relay_edits(), key: 'relayEdits' },
                { label: m.channel_links_relay_deletes(), key: 'relayDeletes' },
                { label: m.channel_links_relay_pins(), key: 'relayPins' },
              ] as toggle}
                <div class="flex items-center justify-between px-3 py-2 rounded-lg bg-surface-container/40 border border-outline-variant/10">
                  <span class="text-sm text-on-surface">{toggle.label}</span>
                  <ToggleSwitch checked={configGroup[toggle.key]} onToggle={(v) => { configGroup[toggle.key] = v; }} size="sm" />
                </div>
              {/each}
            </div>

            <!-- Ces quatre relais sont les seuls à nécessiter une écriture en
                 base : le dire ici, à l'endroit où on les coche, évite d'avoir à
                 le chercher ailleurs. -->
            {#if configGroup.relayEdits || configGroup.relayDeletes || configGroup.relayReactions || configGroup.relayPins}
              <p class="mt-3 text-[11px] text-on-surface-variant/50 leading-relaxed">
                {m.channel_links_storage_notice_on()}
              </p>
            {:else}
              <p class="mt-3 text-[11px] text-emerald-600/80 dark:text-emerald-400/80 leading-relaxed">
                {m.channel_links_storage_notice_off()}
              </p>
            {/if}
          </div>

          <!-- Invitation Discord -->
          <div class="border-t border-outline-variant/20 pt-4">
            <span class="block text-sm font-medium text-on-surface mb-2">{m.channel_links_invite_section_title()}</span>
            <p class="text-xs text-on-surface-variant/50 mb-3">{m.channel_links_invite_section_desc()}</p>

            {#if configInviteUrl}
              <div class="flex flex-col gap-2 px-3 py-3 rounded-lg bg-green-500/10 border border-green-500/30">
                <div class="flex items-center gap-2">
                  <Papicon icon="check-circle" size={14} class="text-green-400" />
                  <span class="text-xs font-semibold text-green-400">
                    {configInviteTopicUpdated ? m.channel_links_invite_added_topic() : m.channel_links_invite_generated()}
                  </span>
                </div>
                {#if !configInviteTopicUpdated}
                  <p class="text-xs text-on-surface-variant/60">{m.channel_links_invite_manual_hint()}</p>
                {/if}
                <div class="flex items-center gap-2">
                  <code class="flex-1 text-xs font-mono bg-surface-container px-2.5 py-1.5 rounded-lg text-on-surface select-all break-all">{configInviteUrl}</code>
                  <button
                    type="button"
                    onclick={() => { navigator.clipboard.writeText(configInviteUrl ?? ''); toast.success(m.channel_links_link_copied()); }}
                    class="p-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors"
                    title={m.common_copy()}
                  >
                    <Papicon icon="copy" size={14} class="text-on-surface-variant" />
                  </button>
                </div>
              </div>
            {:else}
              <button
                type="button"
                onclick={() => handleGenerateInvite(configGroup.id)}
                disabled={generatingInvite}
                class="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm hover:bg-surface-container-high transition-colors disabled:opacity-50"
              >
                {#if generatingInvite}
                  <div class="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full"></div>
                  {m.channel_links_generating_invite()}
                {:else}
                  <Papicon icon="link" size={14} class="text-on-surface-variant" />
                  {m.channel_links_generate_invite_btn()}
                {/if}
              </button>
            {/if}
          </div>

          <button
            onclick={handleUpdateConfig}
            disabled={saveAction.state.loading}
            class="w-full px-4 py-2.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium disabled:opacity-50"
          >
            {saveAction.state.loading ? m.channel_links_saving() : m.common_save()}
          </button>
        </div>
      {/if}
    </Modal>

    <!-- Delete Confirm Modal -->
    <Modal bind:open={showDeleteModal} title={m.channel_links_delete_modal_title()}>
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-on-surface-variant">
          {m.channel_links_delete_modal_desc()}
        </p>
        <div class="flex gap-3 justify-end">
          <button
            onclick={() => { showDeleteModal = false; }}
            class="px-4 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm hover:bg-surface-container-high transition-colors"
          >
            {m.common_cancel()}
          </button>
          <button
            onclick={handleDelete}
            class="px-4 py-2 rounded-lg bg-red-500 text-white text-sm hover:bg-red-600 transition-colors"
          >
            {m.common_delete()}
          </button>
        </div>
      </div>
    </Modal>
  {/snippet}
</ModulePage>
