/** Types partages par les composants de la console admin. */

export interface AdminTableColumn {
  key: string;
  label: string;
  /** Cle de tri ; absente = colonne non triable. */
  sortKey?: string;
  align?: 'left' | 'right' | 'center';
  /** Classe de largeur Tailwind, ex: `w-40`. */
  width?: string;
  /** Colonne masquee sous le point de rupture indique. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
}

export type AdminTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface AdminFilterOption {
  value: string;
  label: string;
  count?: number;
}
