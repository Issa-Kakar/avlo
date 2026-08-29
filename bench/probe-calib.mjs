import { calibrate } from './lib/measure.mjs'
console.log('instrument calibration — bytes per allocation vs V8 ground truth\n')
console.log('  ' + 'probe'.padEnd(30) + 'measured'.padStart(10) + 'expect'.padStart(9) + '   window sizes        verdict')
for (const c of await calibrate()) {
	console.log(
		'  ' + c.label.padEnd(30) +
		String(c.bytes?.toFixed(2) ?? c.reason).padStart(10) +
		String(c.expect ?? '—').padStart(9) +
		('   n=' + c.n1 + '/' + c.n2).padEnd(21) +
		(c.linear ? 'linear' : 'UNSTABLE spread=' + (c.spread * 100).toFixed(1) + '%')
	)
}
