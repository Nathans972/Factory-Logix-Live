/** Visual style tokens for the TV display (spec 8.3). */
export const TV_COLORS = {
  background: '#0b0b0b',
  primaryText: '#d7f000',
  headerText: '#e8e8e8',
  grid: '#ffffff',
  red: '#d21f1f',
  yellow: '#e6c700',
  green: '#2fa84f',
  blue: '#3bb0e0',
  neutral: '#5a5a5a',
  visitor: '#5a5a5a',
} as const;

/** Text color to use on top of a filled cell so the number stays legible. */
export const TV_CELL_TEXT: Record<string, string> = {
  red: '#ffffff',
  yellow: '#111111',
  green: '#111111',
  blue: '#111111',
  visitor: '#e8e8e8',
  neutral: '#9a9a9a',
  blank: '#d7f000',
};
