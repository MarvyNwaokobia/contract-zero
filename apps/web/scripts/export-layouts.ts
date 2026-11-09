// Writes the server's copy of the level geometry. Run after changing levels.ts:
//   npx tsx scripts/export-layouts.ts
import { writeFileSync } from 'node:fs'
import { serverLayouts } from '../src/engine/fps/serverLayouts'
writeFileSync(new URL('../../api/src/services/layouts.json', import.meta.url), JSON.stringify(serverLayouts(), null, 2) + '\n')
console.log('wrote apps/api/src/services/layouts.json')
