<script lang="ts">
  import { m } from './i18n';
  let count = $state(0)
</script>

<button class="counter" onclick={() => count++}>{m.d1_count_is({ count })}</button>
