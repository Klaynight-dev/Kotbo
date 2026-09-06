/**
 * Utilities for filtering and sorting sanctions
 */

export type SortField = 'date' | 'duration' | 'type' | 'status' | 'target' | 'moderator';
export type SortDirection = 'asc' | 'desc';

export interface SanctionFilters {
  statuses: string[];
  types: string[];
  moderators: string[];
  targets: string[];
}

export interface SortOption {
  field: SortField;
  direction: SortDirection;
}

export interface Sanction {
  id: string;
  createdAt: string;
  type: string;
  targetTag: string;
  targetUserId: string;
  moderatorTag: string;
  moderatorUserId: string;
  durationSeconds: number | null;
  status: string;
  reason: string;
  /** Non nul = sanction archivee : desactivee mais conservee. */
  archivedAt?: string | null;
  archiveReason?: string | null;
  /** false = contestation verrouillee par le staff. */
  appealable?: boolean;
  appealLockReason?: string | null;
}

export function filterSanctions(
  sanctions: Sanction[],
  filters: SanctionFilters
): Sanction[] {
  return sanctions.filter((sanction) => {
    // Filter by status
    if (filters.statuses.length > 0 && !filters.statuses.includes(sanction.status)) {
      return false;
    }

    // Filter by type
    if (filters.types.length > 0 && !filters.types.includes(sanction.type)) {
      return false;
    }

    // Filter by moderator
    if (
      filters.moderators.length > 0 &&
      !filters.moderators.includes(sanction.moderatorUserId)
    ) {
      return false;
    }

    // Filter by target
    if (filters.targets.length > 0 && !filters.targets.includes(sanction.targetUserId)) {
      return false;
    }

    return true;
  });
}

export function sortSanctions(
  sanctions: Sanction[],
  sortOptions: SortOption[]
): Sanction[] {
  if (sortOptions.length === 0) {
    return sanctions;
  }

  return [...sanctions].sort((a, b) => {
    for (const { field, direction } of sortOptions) {
      let compareResult = 0;

      switch (field) {
        case 'date':
          compareResult = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'duration':
          compareResult = (a.durationSeconds || 0) - (b.durationSeconds || 0);
          break;
        case 'type':
          compareResult = a.type.localeCompare(b.type);
          break;
        case 'status':
          compareResult = a.status.localeCompare(b.status);
          break;
        case 'target':
          compareResult = a.targetTag.localeCompare(b.targetTag);
          break;
        case 'moderator':
          compareResult = a.moderatorTag.localeCompare(b.moderatorTag);
          break;
      }

      // If not equal, return based on direction
      if (compareResult !== 0) {
        return direction === 'asc' ? compareResult : -compareResult;
      }
    }

    // If all sorts are equal, maintain original order
    return 0;
  });
}

export function filterAndSortSanctions(
  sanctions: Sanction[],
  filters: SanctionFilters,
  sortOptions: SortOption[]
): Sanction[] {
  const filtered = filterSanctions(sanctions, filters);
  return sortSanctions(filtered, sortOptions);
}
