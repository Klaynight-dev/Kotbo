export type MobilePageLayout =
  | 'overview'
  | 'directory'
  | 'planner'
  | 'editor'
  | 'settings'
  | 'detail';

type PageRule = {
  layout: MobilePageLayout;
  paths: string[];
};

/**
 * Mobile behaviour is deliberately assigned by product task, rather than by
 * whichever desktop component happened to be used on the page.
 */
const PAGE_RULES: PageRule[] = [
  {
    layout: 'detail',
    paths: [
      '/events/edit/',
      '/events/control/',
      '/invitations/',
      '/members/',
      '/transcripts/',
      '/sanction-evidence/',
      '/form/',
      '/appeal/',
      '/verify/',
      '/profile/',
    ],
  },
  {
    layout: 'planner',
    paths: ['/planning', '/absences', '/meetings', '/events'],
  },
  {
    layout: 'editor',
    paths: [
      '/regulation',
      '/news',
      '/social-networks',
      '/recruitment',
      '/forms/builder',
      '/triggers',
      '/workflows',
      '/giveaways',
      '/welcome',
      '/announcement',
      '/reaction-roles',
      '/suggestions',
      '/embed-builder',
      '/clans',
    ],
  },
  {
    layout: 'directory',
    paths: [
      '/activity',
      '/logs',
      '/security/sanctions',
      '/security/accounts',
      '/members',
      '/forms',
      '/tickets',
      '/transcripts-list',
      '/message-search',
      '/inbox',
      '/security/filters/nicknames',
      '/invitations',
      '/staff-management',
      '/admin/servers',
      '/admin/shards',
      '/admin/content',
      '/admin/modules',
      '/admin/activation',
    ],
  },
  {
    layout: 'overview',
    paths: [
      '/',
      '/admin/analytics',
      '/analytics',
      '/pulse',
      '/channel-health',
      '/satisfaction',
      '/reputation',
      '/seasons',
      '/prestige',
      '/predictions',
      '/marketplace',
      '/simulation',
      '/quests',
      '/leveling',
      '/economy',
      '/admin',
    ],
  },
];

export function getMobilePageLayout(path: string): MobilePageLayout {
  for (const rule of PAGE_RULES) {
    if (
      rule.paths.some((prefix) =>
        prefix === '/' ? path === '/' : path === prefix || path.startsWith(`${prefix}/`),
      )
    ) {
      return rule.layout;
    }
  }
  return 'settings';
}

export function getPageKey(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return 'home';
  if (parts[0] === 'admin' && parts[1]) return `admin-${parts[1]}`;
  return parts[0].replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}
