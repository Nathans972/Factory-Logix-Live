/** Line icons shared by the shell (rail, top bar) and the Home tiles. 24 px grid, stroke = currentColor. */

export type IconName =
  | 'home'
  | 'shift'
  | 'floor'
  | 'jobs'
  | 'operators'
  | 'products'
  | 'displays'
  | 'shifts'
  | 'breaks'
  | 'connection'
  | 'mapping'
  | 'standards'
  | 'engine'
  | 'users'
  | 'sync'
  | 'audit'
  | 'factory'
  | 'gear'
  | 'help'
  | 'moon'
  | 'sun'
  | 'menu'
  | 'search'
  | 'chevron-down'
  | 'arrow-left';

const PATHS: Record<IconName, string> = {
  home: 'M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5',
  shift: 'M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v4h-7zM3 13h7v8H3zM14 17h7v4h-7z',
  floor: 'M3 4h18v6H3zM3 14h8v6H3zM14 14h7v6h-7z',
  jobs: 'M4 4h12l4 4v12H4zM16 4v4h4',
  operators: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1',
  products: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  displays: 'M3 4h18v12H3zM9 20h6M12 16v4',
  shifts: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3.5 2',
  breaks: 'M4 9h13v5a5 5 0 01-5 5H9a5 5 0 01-5-5zM17 10h2a2.5 2.5 0 010 5h-2M6 3v2M10 3v2M14 3v2',
  connection: 'M9 7V4h6v3M8 7h8v5a4 4 0 01-8 0zM12 16v5',
  mapping: 'M3 5h6v4H3zM15 15h6v4h-6zM9 7h3a2 2 0 012 2v8',
  standards: 'M3 9h18v6H3zM7 9v3M11 9v3M15 9v3M19 9v3',
  engine: 'M4 7h16M4 12h16M4 17h16M9 5v4M15 10v4M7 15v4',
  users: 'M9 12a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2 20v-1a5 5 0 015-5h4a5 5 0 015 5v1M17 6.2a3.5 3.5 0 010 6.6M18 14h1a4 4 0 014 4v2',
  sync: 'M3 12a9 9 0 0115-6.7L21 8M21 12a9 9 0 01-15 6.7L3 16M21 4v4h-4M3 20v-4h4',
  audit: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7M9 8h3',
  factory: 'M3 21V10l6 4v-4l6 4V5h6v16zM7 17h2M12 17h2M17 17h2',
  gear:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  menu: 'M3 6h18M3 12h18M3 18h18',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3',
  'chevron-down': 'M6 9l6 6 6-6',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
