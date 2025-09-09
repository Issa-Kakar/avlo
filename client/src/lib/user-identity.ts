// Random adjective-animal name lists
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

const COLORS = [
  '#FF6B6B',
  '#4ECDC4',
  '#45B7D1',
  '#96CEB4',
  '#FFEAA7',
  '#DDA0DD',
  '#98D8C8',
  '#F7DC6F',
  '#85C1E2',
  '#F8B739',
  '#52B788',
  '#E76F51',
];

export interface UserProfile {
  name: string;
  color: string;
}

export function generateUserProfile(): UserProfile {
  // Generate random indices using crypto.getRandomValues
  const randomValues = new Uint32Array(3);
  crypto.getRandomValues(randomValues);

  // Random name from lists
  const adjIndex = randomValues[0] % ADJECTIVES.length;
  const animalIndex = randomValues[1] % ANIMALS.length;
  const name = `${ADJECTIVES[adjIndex]} ${ANIMALS[animalIndex]}`;

  // Random color from palette
  const colorIndex = randomValues[2] % COLORS.length;
  const color = COLORS[colorIndex];

  return { name, color };
}
