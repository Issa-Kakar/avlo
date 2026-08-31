// The shipped web/src/core/py modules use extensionless relative imports
// (`./py-trace`), which Node's type-stripping resolver rejects — retry with
// `.ts` appended so harness/corpus can import the EXACT shipped TS sources.
// Import this FIRST (before any dynamic TS import); static node: builtins are
// unaffected. Owns the Node ≥ 23.6 guard (type-stripping + registerHooks) —
// it must run before the registerHooks call, and import hoisting would beat
// any guard left in the importer.
import { registerHooks } from 'node:module';

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 23 || (maj === 23 && min < 6)) {
  console.error(`py-build scripts need Node ≥ 23.6 (type-stripping); this is ${process.versions.node}`);
  process.exit(1);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
      throw err;
    }
  },
});
