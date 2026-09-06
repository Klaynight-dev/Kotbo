<script lang="ts">
  import { m } from '../lib/i18n';
  import { escapeHtml, safeUrl } from '../lib/emojiParser';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { 
    fetchNews, 
    fetchPublicNews,
    createNews, 
    updateNews, 
    deleteNews, 
    API_BASE_URL, 
    fetchNewsCategoryConfigs, 
    createNewsCategoryConfig, 
    deleteNewsCategoryConfig 
  } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';

  const { serverId = '' }: { serverId?: string } = $props();

  // State management
  let articles = $state<any[]>([]);
  let loading = $state(false);
  let showEditor = $state(false);
  let isEditing = $state(false);

  // Tab State
  const newsTabs = ['articles', 'configs'] as const;
  let activeTab = $state<'articles' | 'configs'>('articles');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/news', newsTabs, 'articles') as typeof activeTab;
  });
  let categoryConfigs = $state<any[]>([]);
  let loadingConfigs = $state(false);

  // Category Config Form State
  let configCategory = $state('');
  let configSubcategory = $state('');
  let configChannelId = $state('');

  // Editor form state
  let currentArticleId = $state<string | null>(null);
  let title = $state('');
  let content = $state('');
  let summary = $state('');
  let imageUrl = $state('');
  let category = $state(m.news_cat_update());
  let subcategory = $state('');
  let published = $state(false);
  let publishMode = $state<'summary' | 'full_embed'>('summary');

  // Filtering & Search
  let searchQuery = $state('');
  let categoryFilter = $state('ALL');
  let guildId = $state(authStore.selectedGuildId || (typeof localStorage !== 'undefined' ? localStorage.getItem('kotbo_guild_id') : '') || '');
  const isPublicView = $derived(!!serverId);

  const actionState = createAsyncActionState();

  const categories = $derived([
    m.news_cat_update(),
    m.news_cat_patch(),
    m.news_cat_announcement(),
    m.news_cat_blog(),
    m.news_cat_staff()
  ]);

  const filteredArticles = $derived(
    (articles || []).filter(art => {
      const matchesSearch = (art?.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                            (art?.summary && art.summary.toLowerCase().includes(searchQuery.toLowerCase())) ||
                            (art?.authorName || '').toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCategory = categoryFilter === 'ALL' || art?.category === categoryFilter;
      return matchesSearch && matchesCategory;
    })
  );

  const forumSections = $derived.by(() => {
    const categoryMap = new Map<string, Map<string, any[]>>();

    for (const article of filteredArticles) {
      const articleCategory = article?.category || m.news_uncategorized();
      const articleSubcategory = article?.subcategory?.trim() || m.news_general();

      if (!categoryMap.has(articleCategory)) {
        categoryMap.set(articleCategory, new Map());
      }

      const subcategoryMap = categoryMap.get(articleCategory)!;
      if (!subcategoryMap.has(articleSubcategory)) {
        subcategoryMap.set(articleSubcategory, []);
      }

      subcategoryMap.get(articleSubcategory)!.push(article);
    }

    return Array.from(categoryMap.entries())
      .map(([categoryName, subcategoryMap]) => ({
        categoryName,
        totalCount: Array.from(subcategoryMap.values()).reduce((count, items) => count + items.length, 0),
        subcategories: Array.from(subcategoryMap.entries()).map(([subcategoryName, items]) => ({
          subcategoryName,
          totalCount: items.length,
          articles: [...items].sort((left, right) => {
            const leftDate = new Date(left?.publishedAt || 0).getTime();
            const rightDate = new Date(right?.publishedAt || 0).getTime();
            return rightDate - leftDate;
          })
        }))
      }))
      .sort((left, right) => right.totalCount - left.totalCount || left.categoryName.localeCompare(right.categoryName, 'fr'));
  });

  const canEdit = $derived(
    !isPublicView && (
      !!dashboardStore.state.featureAccess?.news?.canModerate ||
      !!dashboardStore.state.access?.canModerateContent
    )
  );

  // Récupère l'ID du serveur depuis les articles ou le store
  const currentGuildId = $derived(
    (articles || [])[0]?.guildId ||
    guildId ||
    ''
  );
  const rssFeedUrl = $derived(`${API_BASE_URL}/api/public/rss/${currentGuildId}`);

  onMount(async () => {
    guildId = serverId || authStore.selectedGuildId || localStorage.getItem('kotbo_guild_id') || '';

    if (isPublicView) {
      activeTab = 'articles';
      await loadArticles();
      return;
    }

    await Promise.all([dashboardStore.refresh(), loadArticles(), loadConfigs()]);
  });

  async function loadArticles() {
    loading = true;
    try {
      // dashboardRequest renvoie null quand aucun serveur n'est sélectionné
      const result = isPublicView ? await fetchPublicNews(guildId) : await fetchNews();
      articles = Array.isArray(result) ? result : [];
    } catch (err) {
      console.error(err);
      articles = [];
    } finally {
      loading = false;
    }
  }

  async function loadConfigs() {
    if (isPublicView) {
      categoryConfigs = [];
      loadingConfigs = false;
      return;
    }
    loadingConfigs = true;
    try {
      const result = await fetchNewsCategoryConfigs();
      categoryConfigs = Array.isArray(result) ? result : [];
    } catch (err) {
      console.error(err);
      categoryConfigs = [];
    } finally {
      loadingConfigs = false;
    }
  }

  function openCreate() {
    currentArticleId = null;
    title = '';
    content = '';
    summary = '';
    imageUrl = '';
    category = m.news_cat_update();
    subcategory = '';
    published = false;
    publishMode = 'summary';
    isEditing = false;
    showEditor = true;
  }

  function openEdit(art: any) {
    currentArticleId = art.id;
    title = art.title;
    content = art.content;
    summary = art.summary || '';
    imageUrl = art.imageUrl || '';
    category = art.category;
    subcategory = art.subcategory || '';
    published = art.published;
    publishMode = 'summary';
    isEditing = true;
    showEditor = true;
  }

  async function handleSave() {
    if (!title.trim() || !content.trim()) {
      toast.error(m.news_err_title_content_req());
      return;
    }

    const payload = {
      title,
      content,
      summary: summary || undefined,
      imageUrl: imageUrl || undefined,
      category,
      subcategory: subcategory || '',
      published,
      publishMode
    };

    await actionState.run(async () => {
      if (isEditing && currentArticleId) {
        await updateNews(currentArticleId, payload);
      } else {
        await createNews(payload);
      }
      showEditor = false;
      await loadArticles();
      return true;
    }, { successMessage: isEditing ? m.news_toast_updated() : m.news_toast_created() });
  }

  async function handleDelete(id: string) {
    if (!(await confirmDialog.danger(m.news_confirm_delete_article()))) return;

    await actionState.run(async () => {
      await deleteNews(id);
      await loadArticles();
      return true;
    }, { successMessage: m.news_toast_article_deleted() });
  }

  async function handleSaveConfig() {
    if (!configCategory.trim() || !configChannelId) {
      toast.error(m.news_err_category_channel_req());
      return;
    }

    await actionState.run(async () => {
      await createNewsCategoryConfig({
        category: configCategory.trim(),
        subcategory: configSubcategory.trim() || undefined,
        channelId: configChannelId
      });
      configCategory = '';
      configSubcategory = '';
      configChannelId = '';
      await loadConfigs();
      return true;
    }, { successMessage: m.news_toast_config_saved() });
  }

  async function handleDeleteConfig(id: string) {
    if (!(await confirmDialog.danger(m.news_confirm_delete_config()))) return;

    await actionState.run(async () => {
      await deleteNewsCategoryConfig(id);
      await loadConfigs();
      return true;
    }, { successMessage: m.news_toast_config_deleted() });
  }

  function copyRssUrl() {
    navigator.clipboard.writeText(rssFeedUrl);
    toast.success(m.news_rss_copied_toast());
  }

  // Markdown live preview parser
  function interpretMarkdown(text: string) {
    if (!text) return `<p class="text-on-surface-variant/40 italic">${m.news_preview_empty_content()}</p>`;
    
    return escapeHtml(text)
      // Headers
      .replace(/^### (.*$)/gim, '<h5 class="text-sm font-semibold uppercase tracking-wider text-primary mt-4 mb-2">$1</h5>')
      .replace(/^## (.*$)/gim, '<h4 class="text-base font-semibold text-on-surface mt-6 mb-3 border-b border-outline-variant/20 pb-1">$1</h4>')
      .replace(/^# (.*$)/gim, '<h3 class="text-xl font-semibold text-on-surface mt-8 mb-4">$1</h3>')
      // Bold & Italic
      .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-primary">$1</strong>')
      .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
      // Links
      .replace(/\[(.*?)\]\((.*?)\)/g, (_match, label: string, url: string) => {
        const href = safeUrl(url);
        if (!href) return label;
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline font-bold">${label}</a>`;
      })
      // Blockquotes
      .replace(/^> (.*$)/gim, '<blockquote class="border-l-4 border-primary/30 pl-4 py-1 my-2 bg-primary/5 rounded-r-lg italic text-sm text-on-surface-variant">$1</blockquote>')
      // List items
      .replace(/^- (.*$)/gim, '<li class="ml-4 list-disc text-sm text-on-surface-variant">$1</li>')
      // Line breaks
      .replace(/\n/g, '<br/>');
  }

  function formatDate(date: string) {
    return new Date(date).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
</script>

<ModulePage
  title={m.news_page_title()}
  description={isPublicView
    ? m.news_page_desc_public()
    : m.news_page_desc_admin()}
  icon="rss"
>
  {#snippet actions()}
    {#if showEditor}
      <button
        onclick={() => showEditor = false}
        class="px-5 py-2.5 bg-surface-container-high text-on-surface font-medium text-[13px] rounded-lg shadow hover:bg-surface-container-highest transition-all"
      >
        {m.news_back_to_list()}
      </button>
    {:else if canEdit}
      <button
        onclick={openCreate}
        class="px-6 py-2.5 bg-primary text-on-primary font-medium text-[13px] rounded-lg transition-all"
      >
        {m.news_create_btn()}
      </button>
    {/if}
  {/snippet}

  {#if !isPublicView}
    <InlineFeedback state={actionState} />
  {/if}

  {#if showEditor}
    <!-- EDITOR WORKSPACE -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <!-- Editor Form -->
      <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <h3 class="text-xl font-semibold flex items-center gap-3">
          <Papicon icon="edit" size={20} class="text-primary" />
          {isEditing ? m.news_edit_title() : m.news_create_title()}
        </h3>

        <div class="space-y-4">
          <!-- Title -->
          <div class="space-y-1.5">
            <label for="news-title" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.news_field_title_label()}</label>
            <input 
              id="news-title" 
              type="text" 
              bind:value={title} 
              placeholder={m.news_field_title_ph()}
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all outline-none"
            />
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <!-- Category -->
            <div class="space-y-1.5">
              <label for="news-category" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.news_field_category_label()}</label>
              <input 
                id="news-category" 
                type="text"
                list="categories-list"
                bind:value={category} 
                placeholder={m.news_field_category_ph()}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all outline-none"
              />
              <datalist id="categories-list">
                {#each categories as cat}
                  <option value={cat}></option>
                {/each}
              </datalist>
            </div>

            <!-- Subcategory -->
            <div class="space-y-1.5">
              <label for="news-subcategory" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.news_field_subcategory_label()}</label>
              <input 
                id="news-subcategory" 
                type="text"
                bind:value={subcategory} 
                placeholder={m.news_field_subcategory_ph()}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all outline-none"
              />
            </div>

            <!-- Published checkbox -->
            <div class="flex items-center justify-between p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5">
              <div>
                <p class="text-xs font-bold leading-tight">{m.news_publish_now_label()}</p>
                <p class="text-[11px] text-on-surface-variant/50">{m.news_publish_now_sub()}</p>
              </div>
              <input 
                type="checkbox" 
                bind:checked={published}
                class="w-5 h-5 rounded border-outline-variant text-primary focus:ring-primary/30"
              />
            </div>
          </div>

          <div class="space-y-2 rounded-lg border border-outline-variant/10 bg-surface-container-high/20 p-4">
            <p class="text-[10px] font-bold text-on-surface-variant/70 uppercase tracking-widest">{m.news_publish_mode_label()}</p>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onclick={() => (publishMode = 'summary')}
                class="rounded-xl px-4 py-2.5 text-xs font-bold transition-all border {publishMode === 'summary' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-outline-variant/20 bg-surface text-on-surface-variant'}"
              >
                {m.news_publish_mode_summary()}
              </button>
              <button
                type="button"
                onclick={() => (publishMode = 'full_embed')}
                class="rounded-xl px-4 py-2.5 text-xs font-bold transition-all border {publishMode === 'full_embed' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-outline-variant/20 bg-surface text-on-surface-variant'}"
              >
                {m.news_publish_mode_full()}
              </button>
            </div>
            <p class="text-[11px] text-on-surface-variant/70">
              {m.news_publish_mode_sub()}
            </p>
          </div>

          <!-- Image URL -->
          <div class="space-y-1.5">
            <label for="news-image" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.news_field_image_label()}</label>
            <input 
              id="news-image" 
              type="text" 
              bind:value={imageUrl} 
              placeholder="https://example.com/image.png"
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all outline-none"
            />
          </div>

          <!-- Summary -->
          <div class="space-y-1.5">
            <label for="news-summary" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.news_field_summary_label()}</label>
            <textarea 
              id="news-summary" 
              bind:value={summary} 
              rows="2" 
              placeholder={m.news_field_summary_ph()}
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all outline-none resize-none"
            ></textarea>
          </div>

          <!-- Content (Markdown) -->
          <div class="space-y-1.5">
            <label for="news-content" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.news_field_content_label()}</label>
            <textarea 
              id="news-content" 
              bind:value={content} 
              rows="12" 
              placeholder={m.news_field_content_ph()}
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-4 text-sm focus:ring-2 focus:ring-primary/30 transition-all outline-none font-mono"
            ></textarea>
          </div>

          <!-- Save Button -->
          <div class="pt-4 flex justify-end gap-4">
            <button 
              onclick={() => showEditor = false}
              class="px-6 py-3 bg-surface-container-high text-on-surface font-bold text-sm rounded-lg hover:bg-surface-container-highest transition-all"
            >
              {m.news_cancel_btn()}
            </button>
            <button 
              onclick={handleSave}
              class="px-8 py-3 bg-primary text-on-primary font-medium text-[13px] rounded-lg transition-all"
            >
              {isEditing ? m.news_update_btn() : m.news_submit_create_btn()}
            </button>
          </div>
        </div>
      </section>

      <!-- Live Preview -->
      <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl flex flex-col h-full">
        <h3 class="text-xl font-semibold flex items-center gap-3 mb-6 shrink-0">
          <Papicon icon="eye" size={20} class="text-secondary" />
          {m.news_preview_title()}
        </h3>
        
        <div class="flex-1 bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-8 overflow-y-auto max-h-150 custom-scrollbar prose prose-invert">
          {#if imageUrl}
            <img src={imageUrl} alt="Illustration" class="w-full h-48 object-cover rounded-lg mb-6 border border-outline-variant/20" />
          {/if}
          <div class="mb-4 flex flex-wrap gap-2">
            <span class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-primary/10 text-primary">
              {category}
            </span>
            {#if subcategory}
              <span class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-secondary/10 text-secondary">
                {subcategory}
              </span>
            {/if}
          </div>
          <h2 class="text-2xl font-semibold text-on-surface mb-2">{title || m.news_preview_default_title()}</h2>
          {#if summary}
            <p class="text-sm font-medium text-on-surface-variant border-l-2 border-outline-variant/30 pl-4 py-1 italic mb-6">{summary}</p>
          {/if}
          <div class="text-sm text-on-surface-variant leading-relaxed">
            {@html interpretMarkdown(content)}
          </div>
        </div>
      </section>
    </div>
  {:else}
    <!-- Tab Switcher -->
    <div class="flex border-b border-outline-variant/20 mb-8 shrink-0">
      <button 
        onclick={() => gotoTab('/news', 'articles', 'articles')}
        class="tab-button {activeTab === 'articles' ? 'active' : ''}"
      >
        {m.news_tab_articles()}
        {#if activeTab === 'articles'}
          <div class="absolute bottom-0 left-8 right-8 h-0.5 bg-primary rounded-t-full"></div>
        {/if}
      </button>
      {#if !isPublicView}
        <button 
          onclick={() => gotoTab('/news', 'configs', 'articles')}
          class="tab-button {activeTab === 'configs' ? 'active' : ''}"
        >
          {m.news_tab_configs()}
          {#if activeTab === 'configs'}
            <div class="absolute bottom-0 left-8 right-8 h-0.5 bg-primary rounded-t-full"></div>
          {/if}
        </button>
      {/if}
    </div>

    {#if activeTab === 'articles'}
      <!-- LIST VIEW -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <!-- RSS feed copy link card (Wide on desktop) -->
        <section class="lg:col-span-3 bg-linear-to-r from-primary/10 via-secondary/5 to-transparent border border-outline-variant/20 p-8 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div class="space-y-2">
            <h3 class="text-lg font-semibold flex items-center gap-2.5">
              <Papicon icon="globe" size={20} class="text-primary" />
              {m.news_rss_card_title()}
            </h3>
            <p class="text-xs text-on-surface-variant font-medium max-w-2xl">
              {m.news_rss_card_desc()}
            </p>
          </div>
          <div class="flex items-center gap-2 bg-surface-container-low border border-outline-variant/25 px-5 py-3 rounded-lg w-full md:w-auto md:min-w-100">
            <span class="text-xs font-mono text-on-surface truncate flex-1">{rssFeedUrl}</span>
            <button 
              onclick={copyRssUrl} 
              class="p-2 text-primary hover:bg-primary/10 rounded-xl transition-all"
              title={m.news_rss_copy_tooltip()}
            >
              <Papicon icon="copy" size={18} />
            </button>
          </div>
        </section>

        <!-- Articles list table/cards -->
        <section class="lg:col-span-3 bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <!-- Search & filters -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div class="relative flex-1 max-w-md">
              <span class="absolute inset-y-0 left-0 pl-4 flex items-center text-on-surface-variant/40">
                <Papicon icon="search" size={18} />
              </span>
              <input 
                type="text" 
                bind:value={searchQuery} 
                placeholder={m.news_search_ph()} 
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg pl-11 pr-5 py-3 text-xs outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>

            <div class="flex items-center gap-2">
              <label for="filter-category" class="text-[10px] font-bold text-on-surface-variant/50 uppercase tracking-wider">{m.news_filter_label()}</label>
              <select 
                id="filter-category" 
                bind:value={categoryFilter} 
                class="bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              >
                <option value="ALL">{m.news_filter_all()}</option>
                {#each categories as cat}
                  <option value={cat}>{cat}</option>
                {/each}
              </select>
            </div>
          </div>

          {#if loading}
            <div class="space-y-4">
              {#each Array(3) as _}
                <div class="p-6 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg flex items-center justify-between">
                  <div class="space-y-2 w-1/3">
                    <Skeleton width="100%" height="16px" />
                    <Skeleton width="60%" height="12px" />
                  </div>
                  <Skeleton width="15%" height="24px" radius="12px" />
                  <Skeleton width="8%" height="32px" radius="8px" />
                </div>
              {/each}
            </div>
          {:else if filteredArticles.length > 0}
            {#if isPublicView}
              <div class="space-y-6">
                <div class="rounded-xl border border-outline-variant/15 bg-surface-container-high/25 p-5 md:p-6">
                  <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div class="space-y-2">
                      <div class="flex items-center gap-2 text-primary">
                        <Papicon icon="globe" size={18} />
                        <span class="text-[10px] font-semibold uppercase tracking-wider">{m.news_forum_view_badge()}</span>
                      </div>
                      <h4 class="text-lg font-semibold text-on-surface">{m.news_forum_view_title()}</h4>
                      <p class="text-xs text-on-surface-variant/70 max-w-2xl">
                        {m.news_forum_view_desc()}
                      </p>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <span class="px-3 py-1.5 rounded-full bg-primary/10 text-primary text-[10px] font-semibold uppercase tracking-wider">{m.news_forum_articles_count({ n: filteredArticles.length })}</span>
                      <span class="px-3 py-1.5 rounded-full bg-secondary/10 text-secondary text-[10px] font-semibold uppercase tracking-wider">{m.news_forum_categories_count({ n: forumSections.length })}</span>
                    </div>
                  </div>
                </div>

                <div class="space-y-5">
                  {#each forumSections as section}
                    <section class="overflow-hidden rounded-xl border border-outline-variant/15 bg-surface-container-low/40 shadow-[0_12px_40px_rgba(0,0,0,0.08)]">
                      <div class="flex flex-col gap-4 border-b border-outline-variant/10 bg-linear-to-r from-primary/10 via-secondary/5 to-transparent px-5 py-4 md:flex-row md:items-center md:justify-between">
                        <div class="space-y-1">
                          <div class="flex items-center gap-2">
                            <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
                              <Papicon icon="folder" size={18} />
                            </span>
                            <div>
                              <h5 class="text-base font-semibold text-on-surface">{section.categoryName}</h5>
                              <p class="text-[11px] uppercase tracking-[0.18em] text-on-surface-variant/55">{m.news_forum_subjects_count({ n: section.totalCount })}</p>
                            </div>
                          </div>
                        </div>
                        <div class="flex flex-wrap gap-2">
                          {#each section.subcategories as subcategorySection}
                            <span class="rounded-full border border-outline-variant/15 bg-surface-container-high/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/75">
                              {subcategorySection.subcategoryName} · {subcategorySection.totalCount}
                            </span>
                          {/each}
                        </div>
                      </div>

                      <div class="divide-y divide-outline-variant/8">
                        {#each section.subcategories as subcategorySection}
                          <div class="grid gap-4 px-5 py-4 md:grid-cols-[220px_minmax(0,1fr)] md:gap-6">
                            <div class="space-y-2">
                              <div class="inline-flex items-center gap-2 rounded-full bg-secondary/10 px-3 py-1 text-xs font-medium text-secondary">
                                <Papicon icon="hash" size={14} />
                                {subcategorySection.subcategoryName}
                              </div>
                              <p class="text-[11px] text-on-surface-variant/60">
                                {m.news_forum_articles_count({ n: subcategorySection.totalCount })}
                              </p>
                            </div>

                            <div class="space-y-3">
                              {#each subcategorySection.articles as art}
                                <article class="group rounded-[1.6rem] border border-outline-variant/10 bg-surface-container-high/25 p-4 transition-all hover:-translate-y-0.5 hover:border-primary/25 hover:bg-surface-container-high/40">
                                  <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                    <div class="flex min-w-0 gap-4">
                                      {#if art.imageUrl}
                                        <img src={art.imageUrl} alt="" class="h-16 w-16 shrink-0 rounded-lg border border-outline-variant/10 object-cover" />
                                      {:else}
                                        <div class="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                          <Papicon icon="newspaper" size={24} />
                                        </div>
                                      {/if}

                                      <div class="min-w-0 space-y-2">
                                        <div class="flex flex-wrap items-center gap-2">
                                          <span class="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-primary">
                                            {art.category}
                                          </span>
                                          {#if art.subcategory}
                                            <span class="rounded-full bg-secondary/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-secondary">
                                              {art.subcategory}
                                            </span>
                                          {/if}
                                          {#if art.published}
                                            <span class="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400">
                                              {m.news_badge_published()}
                                            </span>
                                          {:else}
                                            <span class="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
                                              {m.news_badge_draft()}
                                            </span>
                                          {/if}
                                        </div>

                                        <h6 class="text-base font-semibold text-on-surface transition-colors group-hover:text-primary">{art.title}</h6>
                                        {#if art.summary}
                                          <p class="line-clamp-2 text-sm text-on-surface-variant/80">{art.summary}</p>
                                        {/if}
                                      </div>
                                    </div>

                                    <div class="flex shrink-0 flex-wrap items-center gap-3 text-[11px] text-on-surface-variant/70">
                                      <div class="flex items-center gap-2 rounded-full bg-surface-container-high/55 px-3 py-1.5">
                                        {#if art.authorAvatar}
                                          <img src={art.authorAvatar} alt="" class="h-5 w-5 rounded-full" />
                                        {/if}
                                        <span class="font-bold text-on-surface-variant">{art.authorName}</span>
                                      </div>
                                      <span class="rounded-full bg-surface-container-high/55 px-3 py-1.5 font-medium">{formatDate(art.publishedAt)}</span>
                                    </div>
                                  </div>
                                </article>
                              {/each}
                            </div>
                          </div>
                        {/each}
                      </div>
                    </section>
                  {/each}
                </div>
              </div>
            {:else}
              <div class="overflow-x-auto rounded-xl border border-outline-variant/10">
                <table class="w-full border-collapse text-left">
                  <thead>
                    <tr class="bg-surface-container-high/40 text-xs font-medium text-on-surface-variant/60">
                      <th class="px-6 py-4">{m.news_table_col_article()}</th>
                      <th class="px-6 py-4">{m.news_table_col_category()}</th>
                      <th class="px-6 py-4">{m.news_table_col_author()}</th>
                      <th class="px-6 py-4">{m.news_table_col_pubdate()}</th>
                      <th class="px-6 py-4">{m.news_table_col_status()}</th>
                      {#if canEdit}
                        <th class="px-6 py-4 text-right">{m.news_table_col_actions()}</th>
                      {/if}
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-outline-variant/5">
                    {#each filteredArticles as art}
                      <tr class="hover:bg-surface-container-high/10 transition-colors">
                        <td class="px-6 py-5">
                          <div class="flex items-center gap-4">
                            {#if art.imageUrl}
                              <img src={art.imageUrl} alt="" class="w-12 h-12 object-cover rounded-xl border border-outline-variant/10" />
                            {:else}
                              <div class="w-12 h-12 bg-primary/5 text-primary rounded-xl flex items-center justify-center">
                                <Papicon icon="newspaper" size={20} />
                              </div>
                            {/if}
                            <div>
                              <p class="font-bold text-sm text-on-surface">{art.title}</p>
                              {#if art.summary}
                                <p class="text-xs text-on-surface-variant/80 line-clamp-1 mt-0.5">{art.summary}</p>
                              {/if}
                            </div>
                          </div>
                        </td>
                        <td class="px-6 py-5">
                          <div class="flex flex-col gap-1">
                            <span class="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-primary/10 text-primary w-fit">
                              {art.category}
                            </span>
                            {#if art.subcategory}
                              <span class="text-[11px] text-secondary font-bold uppercase tracking-wider ml-1">↳ {art.subcategory}</span>
                            {/if}
                          </div>
                        </td>
                        <td class="px-6 py-5">
                          <div class="flex items-center gap-2">
                            {#if art.authorAvatar}
                              <img src={art.authorAvatar} alt="" class="w-6 h-6 rounded-full" />
                            {/if}
                            <span class="text-xs font-bold text-on-surface-variant">{art.authorName}</span>
                          </div>
                        </td>
                        <td class="px-6 py-5 text-xs text-on-surface-variant font-medium">
                          {formatDate(art.publishedAt)}
                        </td>
                        <td class="px-6 py-5">
                          {#if art.published}
                            <span class="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400">
                              {m.news_badge_published()}
                            </span>
                          {:else}
                            <span class="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest rounded-full bg-slate-100 text-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
                              {m.news_badge_draft()}
                            </span>
                          {/if}
                        </td>
                        {#if canEdit}
                          <td class="px-6 py-5 text-right">
                            <div class="flex items-center justify-end gap-1">
                              <button 
                                onclick={() => openEdit(art)} 
                                class="p-2 text-on-surface-variant hover:text-primary hover:bg-primary/5 rounded-xl transition-all"
                                title={m.reaction_roles_edit_button_title()}
                              >
                                <Papicon icon="edit" size={16} />
                              </button>
                              <button 
                                onclick={() => handleDelete(art.id)} 
                                class="p-2 text-on-surface-variant hover:text-red-500 hover:bg-red-500/5 rounded-xl transition-all"
                                title={m.reaction_roles_delete_tooltip()}
                              >
                                <Papicon icon="trash" size={16} />
                              </button>
                            </div>
                          </td>
                        {/if}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          {:else}
            <div class="flex flex-col items-center justify-center py-20 border border-dashed border-outline-variant/30 rounded-xl">
              <div class="w-16 h-16 bg-surface-container-high/30 rounded-full flex items-center justify-center text-on-surface-variant/30 mb-4">
                <Papicon icon="rss" size={32} />
              </div>
              <h4 class="text-base font-semibold text-on-surface">{m.news_empty_title()}</h4>
              <p class="text-xs text-on-surface-variant/60 font-medium mt-1">{m.news_empty_desc()}</p>
              {#if canEdit}
                <button 
                  onclick={openCreate}
                  class="mt-6 px-6 py-2.5 bg-primary text-on-primary font-semibold uppercase tracking-widest text-[10px] rounded-xl transition-all"
                >
                  {m.news_create_btn()}
                </button>
              {/if}
            </div>
          {/if}
        </section>
      </div>
    {:else}
      <!-- CONFIGS VIEW -->
      <div class="space-y-8 animate-in fade-in duration-300">
        <section class="overflow-hidden rounded-xl border border-outline-variant/15 bg-surface-container-low/40 shadow-[0_18px_60px_rgba(0,0,0,0.08)]">
          <div class="border-b border-outline-variant/10 bg-linear-to-r from-black/5 via-transparent to-primary/10 px-6 py-5 md:px-8 md:py-6">
            <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div class="space-y-3 max-w-3xl">
                <div class="flex items-center gap-2 text-primary">
                  <Papicon icon="rss" size={18} />
                  <span class="text-[10px] font-semibold uppercase tracking-wider">{m.news_config_badge()}</span>
                </div>
                <div class="space-y-2">
                  <h3 class="text-2xl md:text-lg font-semibold tracking-tight text-on-surface">{m.news_config_title()}</h3>
                  <p class="text-sm text-on-surface-variant/75 leading-relaxed max-w-2xl">
                    {m.news_config_desc()}
                  </p>
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <span class="rounded-full bg-surface-container-high/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">
                  {m.news_config_links_count({ n: categoryConfigs.length })}
                </span>
                <span class="rounded-full bg-primary/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  {m.news_config_channels_count({ n: dashboardStore.state.discordChannels?.length || 0 })}
                </span>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-0 lg:grid-cols-[420px_minmax(0,1fr)]">
            <!-- Mapping Form -->
            <section class="border-b border-outline-variant/10 bg-surface-container-low/20 p-6 md:p-8 lg:border-b-0 lg:border-r">
              <div class="space-y-6">
                <div class="space-y-2">
                  <h4 class="text-lg font-semibold tracking-tight text-on-surface flex items-center gap-3">
                    <span class="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Papicon icon="plus" size={18} />
                    </span>
                    {m.news_config_new_title()}
                  </h4>
                  <p class="text-xs text-on-surface-variant/70 leading-relaxed">
                    {m.news_config_new_desc()}
                  </p>
                </div>

                <div class="space-y-4">
                  <!-- Category Input -->
                  <div class="space-y-1.5">
                    <label for="config-category" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-wider">{m.news_config_rubric_label()}</label>
                    <input
                      id="config-category"
                      type="text"
                      list="categories-config-list"
                      bind:value={configCategory}
                      placeholder={m.news_config_rubric_ph()}
                      class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-5 py-3 text-sm focus:ring-2 focus:ring-primary/30 outline-none transition-all"
                    />
                    <datalist id="categories-config-list">
                      {#each categories as cat}
                        <option value={cat}></option>
                      {/each}
                    </datalist>
                  </div>

                  <!-- Subcategory Input -->
                  <div class="space-y-1.5">
                    <label for="config-subcategory" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-wider">{m.news_config_subrubric_label()}</label>
                    <input
                      id="config-subcategory"
                      type="text"
                      bind:value={configSubcategory}
                      placeholder={m.news_config_subrubric_ph()}
                      class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-5 py-3 text-sm focus:ring-2 focus:ring-primary/30 outline-none transition-all"
                    />
                  </div>

                  <!-- Discord Channel Selector -->
                  <div class="space-y-1.5">
                    <label for="config-channel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-wider">{m.news_config_channel_label()}</label>
                    <SearchableSelect id="config-channel" bind:value={configChannelId} options={(dashboardStore.state.discordChannels || []).map(channel => ({ id: channel.id, name: channelDisplayName(channel) }))} placeholder={m.news_config_channel_ph()} className="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-5 py-3 text-sm focus:ring-2 focus:ring-primary/30 outline-none transition-all" />
                  </div>

                  <!-- Save Config Button -->
                  <button
                    onclick={handleSaveConfig}
                    class="w-full mt-2 py-3 bg-on-surface text-surface font-medium text-[13px] rounded-lg hover:opacity-90 transition-all"
                  >
                    {m.news_config_save_btn()}
                  </button>
                </div>
              </div>
            </section>

            <!-- Mapping List & RSS Feeds -->
            <section class="bg-surface-container-low/10 p-6 md:p-8 space-y-6">
              <div class="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div class="space-y-1">
                  <h4 class="text-lg font-semibold tracking-tight text-on-surface">{m.news_config_index_title()}</h4>
                  <p class="text-xs text-on-surface-variant/65 max-w-2xl">
                    {m.news_config_index_desc()}
                  </p>
                </div>
                <div class="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/45">
                  {m.news_config_public_badge()}
                </div>
              </div>

              {#if loadingConfigs}
                <div class="space-y-4">
                  {#each Array(2) as _}
                    <div class="rounded-xl border border-outline-variant/10 bg-surface-container-high/30 p-5 md:p-6 space-y-4">
                      <div class="space-y-2 w-1/2">
                        <Skeleton width="100%" height="18px" />
                        <Skeleton width="70%" height="12px" />
                      </div>
                      <div class="flex items-center gap-3">
                        <Skeleton width="140px" height="28px" radius="999px" />
                        <Skeleton width="220px" height="12px" />
                      </div>
                    </div>
                  {/each}
                </div>
              {:else if categoryConfigs.length > 0}
                <div class="space-y-4">
                  {#each categoryConfigs as config}
                    <article class="rounded-xl border border-outline-variant/10 bg-surface-container-high/25 p-5 md:p-6 transition-all hover:-translate-y-0.5 hover:bg-surface-container-high/35">
                      <div class="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
                        <div class="space-y-3 min-w-0">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="rounded-full bg-primary/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                              {config.category}
                            </span>
                            {#if config.subcategory}
                              <span class="rounded-full bg-secondary/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-secondary">
                                {config.subcategory}
                              </span>
                            {/if}
                          </div>
                          <div class="space-y-1">
                            <h5 class="text-base font-semibold text-on-surface">#{((dashboardStore.state.discordChannels || []).find(ch => ch.id === config.channelId)?.name) || m.news_unknown_channel()}</h5>
                            <p class="text-xs text-on-surface-variant/65">
                              {m.news_config_discord_linked()}
                            </p>
                          </div>
                        </div>

                        <div class="flex flex-col gap-2 md:items-end">
                          <span class="inline-flex w-fit items-center rounded-full border border-outline-variant/10 bg-surface-container-low px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">
                            {m.news_config_dedicated_rss()}
                          </span>
                          {#if canEdit}
                            <button
                              onclick={() => handleDeleteConfig(config.id)}
                              class="inline-flex items-center gap-2 rounded-full border border-outline-variant/10 bg-transparent px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant hover:border-red-500/20 hover:text-red-500 transition-all"
                              title={m.reaction_roles_delete_tooltip()}
                            >
                              <Papicon icon="trash" size={14} />
                              {m.reaction_roles_delete_tooltip()}
                            </button>
                          {/if}
                        </div>
                      </div>

                      <div class="mt-5 rounded-lg border border-outline-variant/10 bg-surface-container-low/40 px-4 py-3">
                        <p class="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/45 mb-2">{m.news_config_public_feed_label()}</p>
                        <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <p class="font-mono text-[11px] text-on-surface break-all">
                            {API_BASE_URL}/api/public/rss/{currentGuildId}/{encodeURIComponent(config.category)}{config.subcategory ? `/${encodeURIComponent(config.subcategory)}` : ''}
                          </p>
                          <span class="text-[10px] font-medium text-on-surface-variant/60">
                            {m.news_config_rss_ready()}
                          </span>
                        </div>
                      </div>
                    </article>
                  {/each}
                </div>
              {:else}
                <div class="flex flex-col items-center justify-center py-20 border border-dashed border-outline-variant/30 rounded-xl bg-surface-container-high/10">
                  <div class="w-16 h-16 bg-surface-container-high/30 rounded-full flex items-center justify-center text-on-surface-variant/30 mb-4">
                    <Papicon icon="rss" size={32} />
                  </div>
                  <h4 class="text-base font-semibold text-on-surface">{m.news_config_empty_title()}</h4>
                  <p class="text-xs text-on-surface-variant/60 font-medium mt-1 text-center max-w-md">{m.news_config_empty_desc()}</p>
                </div>
              {/if}
            </section>
          </div>
        </section>
      </div>
    {/if}
  {/if}
</ModulePage>
