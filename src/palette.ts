/** One shared 32-colour palette: the 3D scene is quantised to it and all sprites/HUD use it. */
export const C = {
  ink: '#1a1c2c',
  ink2: '#2b2d4a',
  night: '#3b3f6b',
  dusk: '#4d5d9b',
  sky: '#5d8bd6',
  skyLight: '#8ec5f0',
  skyPale: '#c7e8f7',
  white: '#f4f4f4',
  yellow: '#ffcd75',
  cream: '#ffe9a3',
  orange: '#f6a35c',
  coral: '#ef7d57',
  red: '#d9485f',
  wine: '#a8324b',
  pink: '#f2a7c3',
  purple: '#b56cbf',
  plum: '#6b3e75',
  forestDeep: '#2e5a3a',
  forest: '#38714a',
  green: '#4f9a55',
  greenLight: '#7cc26b',
  lime: '#b5e07a',
  tealDeep: '#2a4a4f',
  moss: '#3e7a72',
  sage: '#6aa69a',
  brown: '#8b6b4a',
  brownDark: '#5c4033',
  tan: '#c49a6c',
  rock: '#9aa0a8',
  rockDark: '#6b717c',
  greyLight: '#d5d9de',
  skin: '#f4c7a1',
} as const;

export type ColorName = keyof typeof C;

export const PALETTE: string[] = Object.values(C);

export function rgb01(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
