export const computeBackoff = (attempt: number) => {
  const base = 500;
  const max = 30_000;
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.floor(Math.random() * exp);
};
