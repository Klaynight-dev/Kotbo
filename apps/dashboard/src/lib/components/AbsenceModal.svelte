<script lang="ts">
  import { m } from '../i18n';
  import Papicon from './Papicon.svelte';
  import FormInput from './FormInput.svelte';
  import FormSelect from './FormSelect.svelte';
  import FormTextarea from './FormTextarea.svelte';
  import ActionButton from './ActionButton.svelte';
  import Modal from './Modal.svelte';

  let {
    show = false,
    onClose = () => {},
    onSave = (data: any) => {},
    staffMembers = [],
    eligibleSuperiors = [],
    isAdmin = false,
    initialDate = new Date(),
    initialEndDate = null
  } = $props<{
    show?: boolean;
    onClose?: (e?: any) => void;
    onSave?: (data: any) => Promise<void> | void;
    staffMembers?: any[];
    eligibleSuperiors?: any[];
    isAdmin?: boolean;
    initialDate?: Date;
    initialEndDate?: Date | null;
  }>();

  let saving = $state(false);
  let errorMsg = $state('');

  let startDate = $state('');
  let startTime = $state('');
  let endDate = $state('');
  let endTime = $state('');
  let isAllDay = $state(true);
  let reason = $state('');
  let type = $state('CONGÉ');
  let superiorUserId = $state('');

  $effect(() => {
    if (show) {
      startDate = initialDate.toLocaleDateString('en-CA');
      startTime = initialDate.toTimeString().slice(0, 5);
      
      const end = initialEndDate || new Date(initialDate.getTime() + 3600000);
      endDate = end.toLocaleDateString('en-CA');
      endTime = end.toTimeString().slice(0, 5);
      
      isAllDay = !initialEndDate;
      // Reset other fields too
      reason = '';
      type = 'CONGÉ';
      superiorUserId = '';
    }
  });
  let isIndefinite = $state(false);
  let confirmIndefinite = $state(false);

  const absenceTypes = [
    { value: 'CONGÉ', label: m.e5_absence_type_conge() },
    { value: 'MALADIE', label: m.e5_absence_type_maladie() },
    { value: 'PERSONNEL', label: m.e5_absence_type_personnel() },
    { value: 'TRAVAIL', label: m.e5_absence_type_travail() },
    { value: 'RÉUNION', label: m.e5_absence_type_reunion() },
    { value: 'AUTRE', label: m.e5_absence_type_autre() }
  ];

  async function handleSave() {
    const requiresSuperior = type !== 'RÉUNION';
    if (!startDate || (!isIndefinite && !endDate) || !reason.trim() || (requiresSuperior && !superiorUserId)) {
      errorMsg = m.e5_absence_error_required();
      return;
    }

    if (!isIndefinite && new Date(endDate) < new Date(startDate)) {
      errorMsg = m.e5_absence_error_end_before_start();
      return;
    }

    saving = true;
    errorMsg = '';

    try {
      await onSave({
        startDate: isAllDay ? new Date(`${startDate}T00:00:00`) : new Date(`${startDate}T${startTime}`),
        endDate: isIndefinite ? null : (isAllDay ? new Date(`${endDate}T23:59:59`) : new Date(`${endDate}T${endTime}`)),
        reason: reason.trim(),
        type,
        superiorUserId,
        isIndefinite,
        confirmIndefinite
      });
      onClose();
    } catch (e: any) {
      errorMsg = e.message || m.e5_absence_error_generic();
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  open={show}
  onClose={onClose}
  title={m.e5_absence_modal_title()}
  subtitle={m.e5_absence_modal_subtitle()}
  size="lg"
  showCloseButton={false}
>
  <div class="flex flex-col h-full">
    <!-- Icon and custom header -->
    <div class="p-8 pb-4">
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 bg-primary rounded-lg flex items-center justify-center ">
          <Papicon icon="calendar-plus" size={24} class="text-white" />
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 px-8 space-y-8 overflow-y-auto">
      <!-- Time Section -->
      <section class="space-y-4">
        <h4 class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.e5_absence_section_time()}</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="space-y-2">
            <label for="start-date" class="block text-xs font-bold text-on-surface-variant ml-1">{m.e5_absence_label_start()}</label>
            <div class="flex gap-2">
              <FormInput id="start-date" type="date" bind:value={startDate} className="flex-[2]" />
              <FormInput type="time" bind:value={startTime} className="flex-1" disabled={isAllDay} />
            </div>
          </div>
          <div class="space-y-2">
            <label for="end-date" class="block text-xs font-bold text-on-surface-variant ml-1">{m.e5_absence_label_end()}</label>
            <div class="flex gap-2">
              <FormInput id="end-date" type="date" bind:value={endDate} className="flex-[2]" disabled={isIndefinite} />
              <FormInput type="time" bind:value={endTime} className="flex-1" disabled={isIndefinite || isAllDay} />
            </div>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-6 px-2">
          <div class="flex items-center gap-3">
            <input type="checkbox" id="all-day" bind:checked={isAllDay} class="w-4 h-4 rounded border-outline text-primary focus:ring-primary" />
            <label for="all-day" class="text-sm font-bold text-on-surface">{m.e5_absence_label_all_day()}</label>
          </div>
          <div class="flex items-center gap-3">
            <input type="checkbox" id="indefinite" bind:checked={isIndefinite} class="w-4 h-4 rounded border-outline text-primary focus:ring-primary" />
            <label for="indefinite" class="text-sm font-bold text-on-surface">{m.e5_absence_label_indefinite()}</label>
          </div>
        </div>
      </section>

      <!-- Details Section -->
      <section class="space-y-6">
        <h4 class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.e5_absence_section_details()}</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
           <div class="space-y-2">
            <label for="type" class="block text-xs font-bold text-on-surface-variant ml-1">{m.e5_absence_label_type()}</label>
            <FormSelect id="type" bind:value={type} className="w-full">
              {#each absenceTypes as at}
                <option value={at.value}>{at.label}</option>
              {/each}
            </FormSelect>
          </div>
          <div class="space-y-2">
            <label for="superior" class="block text-xs font-bold text-on-surface-variant ml-1">{m.e5_absence_label_superior()}</label>
            <FormSelect id="superior" bind:value={superiorUserId} className="w-full">
              <option value="" disabled>{m.e5_absence_superior_placeholder()}</option>
              {#each eligibleSuperiors as superior}
                <option value={superior.userId}>
                  {superior.displayName || superior.username} ({superior.grade})
                </option>
              {/each}
            </FormSelect>
          </div>
        </div>
        <div class="space-y-2">
          <label for="reason" class="block text-xs font-bold text-on-surface-variant ml-1">{m.e5_absence_label_reason()}</label>
          <FormTextarea
            id="reason"
            bind:value={reason}
            placeholder={m.e5_absence_reason_placeholder()}
            rows={3}
            className="w-full"
          />
        </div>
      </section>

      {#if errorMsg}
        <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex gap-3 animate-shake">
          <Papicon icon="alert-circle" size={18} class="text-red-500" />
          <p class="text-xs text-red-700 font-bold">{errorMsg}</p>
        </div>
      {/if}
    </div>

    <!-- Footer -->
    <footer class="p-8 border-t border-outline-variant/30 bg-surface-container-lowest flex items-center justify-end gap-4">
      <button onclick={onClose} class="px-6 py-3 font-bold text-on-surface-variant hover:bg-surface-hover rounded-lg transition-all">
        {m.e5_absence_cancel()}
      </button>
      <button
        onclick={handleSave}
        disabled={saving}
        class="px-5 py-2.5 text-xs rounded-xl font-semibold uppercase tracking-wide bg-primary text-on-primary border border-primary hover:bg-primary-container active:scale-95 transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 flex items-center gap-2"
      >
        {#if saving}
          <div class="w-4 h-4 border-2 border-on-primary border-t-transparent rounded-full animate-spin"></div>
          <span>{m.e5_absence_saving()}</span>
        {:else}
          <Papicon icon="check-circle" size={12} />
          <span>{m.e5_absence_confirm()}</span>
        {/if}
      </button>
    </footer>
  </div>
</Modal>
