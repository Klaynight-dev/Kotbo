/**
 * Global store for tracking unsaved changes across dashboard pages.
 * Works like Discord's settings save bar - pages register their save/reset
 * callbacks, and the UnsavedChangesBar overlay handles displaying the prompt.
 */

type SaveCallback = () => Promise<boolean | void>;
type ResetCallback = () => void;

class UnsavedChangesStore {
  /** Whether there are currently unsaved changes */
  isDirty = $state(false);

  /** Human-readable label shown in the bar (e.g. "Accueil & Départ") */
  pageLabel = $state('');

  /**
   * Identifiant du proprietaire courant, distinct du libelle affiche.
   *
   * Les pages doivent savoir si la barre est la leur avant de l'effacer, sans
   * quoi celle qui se demonte emporte les modifications d'une autre. Le libelle
   * servait a cela, et c'etait un piege : il est traduit, donc il change avec la
   * langue, et il est ecrit deux fois - a l'enregistrement et a la comparaison -
   * donc il derive. La page Doubles comptes enregistrait « Doubles comptes » et
   * comparait « Doubles Comptes » : sa barre ne se vidait jamais.
   *
   * Un identifiant stable, jamais affiche, ferme les deux failles.
   */
  ownerId = $state('');

  /** Whether the save is currently in progress */
  saving = $state(false);

  private _onSave: SaveCallback | null = null;
  private _onReset: ResetCallback | null = null;

  /**
   * Called by a page when it has unsaved changes to register.
   * Pass null to clear (page unmounted / saved).
   */
  register(opts: {
    /** Identifiant stable du proprietaire. A defaut, le libelle, comme avant. */
    id?: string;
    label: string;
    onSave: SaveCallback;
    onReset: ResetCallback;
  }) {
    this.ownerId = opts.id ?? opts.label;
    this.pageLabel = opts.label;
    this._onSave = opts.onSave;
    this._onReset = opts.onReset;
    this.isDirty = true;
  }

  /**
   * Rend la barre, et seulement si elle appartient bien a l'appelant. C'est le
   * seul effacement qu'une page doit appeler : `clear` sans condition ecraserait
   * la barre d'une autre.
   */
  release(id: string) {
    if (this.ownerId === id) this.clear();
  }

  /**
   * Clear the unsaved changes state (called after save or reset).
   */
  clear() {
    this.isDirty = false;
    this.saving = false;
    this.pageLabel = '';
    this.ownerId = '';
    this._onSave = null;
    this._onReset = null;
  }

  /**
   * Trigger the registered save callback.
   * Returns true if save was successful.
   */
  async save(): Promise<boolean> {
    if (!this._onSave) return false;
    this.saving = true;
    try {
      const result = await this._onSave();
      // If the page callback returns false explicitly, keep dirty
      if (result === false) {
        this.saving = false;
        return false;
      }
      this.clear();
      return true;
    } catch {
      this.saving = false;
      return false;
    }
  }

  /**
   * Trigger the registered reset callback and clear state.
   */
  reset() {
    this._onReset?.();
    this.clear();
  }

  /**
   * Check if navigation is safe or ask confirmation.
   * Returns true if navigation can proceed.
   */
  canNavigate(): boolean {
    return !this.isDirty;
  }
}

export const unsavedChanges = new UnsavedChangesStore();
