export const isCoarsePointer = () => matchMedia('(pointer: coarse)').matches;
export const isNarrow = (max = 820) => window.innerWidth <= max;
export const onResize = (cb: () => void) => {
  const h = () => cb();
  window.addEventListener('resize', h);
  return () => window.removeEventListener('resize', h);
};
