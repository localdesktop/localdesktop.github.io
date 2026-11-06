import type { EntityDef } from './types.ts';

export const NEUTRAL: EntityDef[] = [
  {
    id: 'mineral', name: 'Mineral Field', race: 'neutral', kind: 'mineral', desc: 'Workers harvest 5 minerals per trip.',
    cost: { m: 0, g: 0 }, time: 0, size: [2, 1], hp: 1, armor: 0, sight: 0, attrs: ['structure'],
  },
  {
    id: 'geyser', name: 'Gas Geyser', race: 'neutral', kind: 'geyser', desc: 'Build a refinery here to harvest gas.',
    cost: { m: 0, g: 0 }, time: 0, size: [3, 3], hp: 1, armor: 0, sight: 0, attrs: ['structure'],
  },
];
