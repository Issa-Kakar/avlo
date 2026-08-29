import { execFileSync } from 'child_process'
// mode -> frames, chosen so every mode runs long enough to produce many
// collections (allocation is attributed from heap deltas between them)
const PLAN = [
  ['noop', 40000], ['flat-search', 40000], ['rbush-search', 40000],
  ['flat-set', 40000], ['rbush-set', 40000], ['rbush-set-direct', 40000],
  ['flat-upsert-raw', 3000], ['flat-upsert', 3000],
  ['rbush-upsert-reuse', 3000], ['rbush-upsert', 3000],
  ['flat-full', 3000], ['rbush-full', 3000],
]
const only = process.argv.slice(2)
const GC = /(Scavenge|Mark-Compact|Mark-sweep|Full)\s+([\d.]+)\s+\([\d.]+\)\s*->\s*([\d.]+)\s+\([\d.]+\)\s*MB.*?([\d.]+)\s*\/\s*[\d.]+\s*ms/
const rows = []
for (const [mode, frames] of PLAN) {
  if (only.length && !only.includes(mode)) continue
  const out = execFileSync(process.execPath,
    ['--trace-gc', '--max-semi-space-size=1', 'decompose.mjs', mode, String(frames)],
    { encoding: 'utf8', maxBuffer: 1 << 28 })
  let win = false, prev = null, allocMB = 0, scav = 0, major = 0, gcMs = 0, ms = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('###LOOP_START')) { win = true; prev = null; continue }
    if (line.startsWith('###LOOP_END')) { win = false; continue }
    if (line.startsWith('###RESULT')) { ms = Number(line.split(' ')[2]); continue }
    const m = GC.exec(line); if (!m) continue
    if (!win) { prev = Number(m[3]); continue }
    if (prev !== null) allocMB += Number(m[2]) - prev
    prev = Number(m[3])
    if (m[1] === 'Scavenge') scav++; else major++
    gcMs += Number(m[4])
  }
  rows.push({ mode, frames, kb: (allocMB * 1024) / frames, scav, gcMs, ms: ms / frames })
}
const p = (s, n) => String(s).padStart(n)
console.log(`${'mode'.padEnd(20)}${p('frames',8)}${p('KB/frame',10)}${p('scav',7)}${p('gc ms',8)}${p('ms/frame',10)}`)
console.log('-'.repeat(63))
for (const r of rows) console.log(`${r.mode.padEnd(20)}${p(r.frames,8)}${p(r.kb.toFixed(2),10)}${p(r.scav,7)}${p(r.gcMs.toFixed(0),8)}${p(r.ms.toFixed(4),10)}`)
