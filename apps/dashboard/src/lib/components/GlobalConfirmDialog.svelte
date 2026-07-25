<script lang="ts">
  import ConfirmModal from './ConfirmModal.svelte';
  import { confirmDialog } from '../stores/confirmDialog.svelte';
  import { m } from '../i18n';
</script>

<ConfirmModal
  bind:open={confirmDialog.open}
  title={confirmDialog.options.title ?? m.d7_confirm_required()}
  description={confirmDialog.options.description ?? ''}
  confirmLabel={confirmDialog.options.confirmLabel ?? m.d7_confirm()}
  cancelLabel={confirmDialog.options.cancelLabel ?? m.d7_cancel()}
  variant={confirmDialog.options.variant ?? 'default'}
  requireInput={confirmDialog.options.requireInput ?? ''}
  onConfirm={() => confirmDialog.resolve(true)}
  onCancel={() => confirmDialog.resolve(false)}
/>
