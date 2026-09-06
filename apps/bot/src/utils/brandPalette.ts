// ─────────────────────────────────────────────────────────────
// Kotbo Design System - Chalkboard / Tableau Noir Aesthetic
//
// Palette partagee par tous les rendus canvas (cartes de stats, cartes de
// profil, cartes d'aperçu Open Graph). Elle vivait dans imageService, ce qui
// obligeait chaque nouveau rendu a recopier les teintes : la moindre retouche
// de charte laissait alors des images desynchronisees derriere elle.
// ─────────────────────────────────────────────────────────────
export const BRAND = {
  bg1: '#1A2321',
  bg2: '#243330',
  bg3: '#2C3B38',
  card: 'rgba(255, 255, 255, 0.06)',
  cardAlt: 'rgba(255, 255, 255, 0.04)',
  border: 'rgba(255, 255, 255, 0.12)',
  blurple: '#A8C8FF',
  green: '#A8E6CF',
  pink: '#FFB8D0',
  yellow: '#FFEAA7',
  red: '#FF8B94',
  cyan: '#87CEEB',
  textPrimary: '#E8E4D9',
  textSecondary: '#C4BFB4',
  textMuted: '#8A8578',
  textDark: '#5A5650',
  glowBlurple: 'rgba(168, 200, 255, 0.06)',
  glowGreen: 'rgba(168, 230, 207, 0.05)',
  glowPink: 'rgba(255, 184, 208, 0.05)',
  chalk: '#E8E4D9',
  chalkDim: 'rgba(232, 228, 217, 0.5)',
  postItYellow: '#FFF9C4',
  postItPink: '#FFE0E6',
  postItBlue: '#DCEEFB',
  postItGreen: '#D7F0E0',
  tape: 'rgba(200, 190, 160, 0.45)',
} as const;

/** Couleur d'accent Discord (embed sidebar) alignee sur la charte. */
export const BRAND_THEME_COLOR = '#A8C8FF';
