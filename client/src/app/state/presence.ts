export interface Presence {
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  activity: 'idle' | 'drawing' | 'typing';
}

const ADJECTIVES = ['Swift', 'Clever', 'Bright', 'Quick', 'Smooth', 'Creative', 'Happy', 'Brave'];
const ANIMALS = ['Fox', 'Panda', 'Tiger', 'Eagle', 'Dolphin', 'Wolf', 'Bear', 'Hawk'];
const COLORS = [
  '#3B82F6', // blue
  '#14B8A6', // teal
  '#EC4899', // pink
  '#8B5CF6', // purple
  '#F97316', // orange
  '#10B981', // green
  '#EF4444', // red
  '#F59E0B', // amber
];

export function generateUserName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj}${animal}`;
}

export function generateUserColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

export function getInitials(name: string): string {
  const words = name.match(/[A-Z][a-z]*/g) || [];
  if (words.length >= 2) {
    return words[0][0] + words[1][0];
  }
  return name.slice(0, 2).toUpperCase();
}
