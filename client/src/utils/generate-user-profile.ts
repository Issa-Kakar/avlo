const ADJECTIVES = [
  'Swift',
  'Bright',
  'Happy',
  'Clever',
  'Bold',
  'Calm',
  'Eager',
  'Gentle',
  'Keen',
  'Lively',
  'Noble',
  'Quick',
  'Sharp',
  'Wise',
  'Zesty',
];

const ANIMALS = [
  'Fox',
  'Bear',
  'Wolf',
  'Eagle',
  'Owl',
  'Hawk',
  'Lion',
  'Tiger',
  'Lynx',
  'Otter',
  'Seal',
  'Whale',
  'Raven',
  'Swan',
  'Deer',
];

export const COLORS = [
  '#E8915A', // warm orange
  '#5B8DEF', // blue
  '#E05D6F', // rose
  '#4CAF7D', // green
  '#C77DDB', // purple
  '#D4A843', // gold
  '#47B5B5', // teal
  '#E57BA1', // pink
  '#7E8CE0', // indigo
  '#6BBF6B', // lime
  '#C96B4F', // terra cotta
  '#5DADE2', // sky blue
  '#B5854E', // bronze
  '#8FBC5A', // olive
  '#DB7093', // hot pink
  '#7DAFCB', // steel blue
];

export interface UserProfile {
  name: string;
  color: string;
}

export function generateUserProfile(): UserProfile {
  const randomValues = new Uint32Array(3);
  crypto.getRandomValues(randomValues);

  const adjIndex = randomValues[0] % ADJECTIVES.length;
  const animalIndex = randomValues[1] % ANIMALS.length;
  const name = `${ADJECTIVES[adjIndex]} ${ANIMALS[animalIndex]}`;

  const colorIndex = randomValues[2] % COLORS.length;
  const color = COLORS[colorIndex];

  return { name, color };
}
