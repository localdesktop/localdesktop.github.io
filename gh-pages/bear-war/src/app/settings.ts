export interface Settings {
  name: string;
  master: number;
  sfx: number;
  music: number;
  voice: boolean;
  scrollSpeed: number;
  edgeScroll: boolean;
  allBars: boolean;
  lowFx: boolean;
  maxDpr: number;
  server: string;
  tips: boolean;
}

const KEY = 'bear-war:settings';

export const DEFAULT_SETTINGS: Settings = {
  name: 'Commander',
  master: 0.8,
  sfx: 0.8,
  music: 0.4,
  voice: true,
  scrollSpeed: 1,
  edgeScroll: true,
  allBars: false,
  lowFx: false,
  maxDpr: 2,
  server: '',
  tips: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // storage unavailable (private mode), use defaults
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}
