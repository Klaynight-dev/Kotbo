<script lang="ts">
  /**
   * Economie > Configuration rapide : les rythmes, seuls.
   *
   * Ils reglent d'un coup les gains du daily, son delai et l'energie, donc ils ne
   * relevent d'aucun onglet de la page Economie. Leur propre entree de menu en fait le
   * chemin le plus court pour qui veut demarrer sans rien regler en detail.
   */
  import ModulePage from '../lib/components/ModulePage.svelte';
  import EconomyQuickSetup from '../lib/components/economy/EconomyQuickSetup.svelte';
  import { m } from '../lib/i18n';
</script>

<!-- Un module eteint ferme ses routes : sans `featureKey`, cette page tentait de lire une
     configuration que l'API refuse, et ne rendait rien. Le grisage n'est pas une gene mais
     la reponse du dashboard a ce cas, avec l'interrupteur qui rallume juste au-dessus. -->
<ModulePage
  title={m.eco_quick_setup_title()}
  description={m.eco_quick_setup_desc()}
  icon="Sparkles"
  featureKey="economy"
>
  <EconomyQuickSetup />
</ModulePage>
