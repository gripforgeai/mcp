/**
 * Le rendu (« look ») des outils MCP : un paramètre à part du style de jeu. Même vocabulaire que
 * `LOOKS` de `@gripforge/core` (look.ts) — `qa/look-check.mjs` vérifie que les deux listes concordent.
 */
export const LOOK_VALUES = ['stylized', 'painted', 'toon', 'anime', 'realistic', 'lowpoly', 'pixel'] as const;

export const LOOK_DESCRIPTION =
  'Rendering look, separate from the game style: stylized (neutral) | painted | toon | anime | realistic | lowpoly | pixel. Old values (handpainted, cartoon, low_poly…) are read as aliases. Omit for the style default.';
