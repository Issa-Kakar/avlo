export function isAllowedOrigin(origin: string | undefined, csv: string) {
  if (!origin) return false;
  const list = csv.split(',').map(s => s.trim()).filter(Boolean);
  try { const u = new URL(origin); return list.includes(`${u.protocol}//${u.host}`); } catch { return false; }
}