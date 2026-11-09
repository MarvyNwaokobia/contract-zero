// Writes docs/CONTROLS.md from the one controls definition. Run after changing
// lib/controls.ts or lib/keybinds.ts:   npx tsx scripts/export-controls.ts
import { writeFileSync } from 'node:fs'
import { controlsMarkdown } from '../src/lib/controlsDoc'
writeFileSync(new URL('../../../docs/CONTROLS.md', import.meta.url), controlsMarkdown())
console.log('wrote docs/CONTROLS.md')
