<script lang="ts">
  import { m } from '../i18n';

  let {
    checked = false,
    disabled = false,
    onToggle = (_v: boolean) => {},
    size = 'md',
    activeClass = '',
    id = undefined,
    ariaLabel = undefined
  }: {
    checked?: boolean;
    disabled?: boolean;
    onToggle?: (checked: boolean) => void;
    size?: 'sm' | 'md' | 'lg';
    activeClass?: string;
    id?: string | undefined;
    ariaLabel?: string | undefined;
  } = $props();

  const sizeClasses = {
    sm: { track: 'w-8 h-[18px]', knob: 'h-3.5 w-3.5', offset: 'top-[2px] left-[2px]', translate: 'translate-x-[14px]' },
    md: { track: 'w-10 h-[22px]', knob: 'h-4 w-4', offset: 'top-[3px] left-[3px]', translate: 'translate-x-[18px]' },
    lg: { track: 'w-12 h-[26px]', knob: 'h-5 w-5', offset: 'top-[3px] left-[3px]', translate: 'translate-x-[22px]' },
  };

  const s = $derived(sizeClasses[size] || sizeClasses.md);
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={ariaLabel ?? m.e6_toggle_switch_aria_label()}
  {id}
  {disabled}
  onclick={() => { if (!disabled) onToggle(!checked); }}
  class="relative inline-flex shrink-0 {s.track} rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface {disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'} {checked ? (activeClass || 'bg-primary') : 'bg-zinc-600'}"
>
  <span
    class="pointer-events-none absolute {s.offset} {s.knob} rounded-full bg-white shadow-sm transition-transform duration-200 {checked ? s.translate : 'translate-x-0'}"
  ></span>
</button>
