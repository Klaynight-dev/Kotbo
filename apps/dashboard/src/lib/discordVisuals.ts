const CHANNEL_ICONS: Record<string, string> = {
  voice: 'volume-2',
  forum: 'message-square',
  media: 'image',
  thread: 'git-branch',
  announcement: 'megaphone',
};

export function channelIconName(type?: string): string {
  return CHANNEL_ICONS[type ?? ''] ?? 'hash';
}

/** Discord renvoie #000000 pour « pas de couleur » : la pastille passe au neutre. */
export function roleDotColor(color?: string | null): string {
  return !color || color === '#000000' ? 'var(--outline)' : color;
}
