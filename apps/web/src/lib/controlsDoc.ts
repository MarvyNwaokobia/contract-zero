// docs/CONTROLS.md, generated from the one controls definition (lib/controls) with the
// default key bindings. scripts/export-controls.ts writes it; a test fails if it drifts.
import { desktopControls, FIELD_RULES, TOUCH_CONTROLS, type ControlRow } from './controls'

const table = (rows: ControlRow[]) => ['| Action | Control | Notes |', '|---|---|---|', ...rows.map((r) => `| ${r.action} | ${r.keys.replace(/\|/g, '\\|')} | ${r.note ?? ''} |`)].join('\n')

export function controlsMarkdown(): string {
  return [
    '# Controls',
    '',
    '<!-- Generated from apps/web/src/lib/controls.ts by `npx tsx scripts/export-controls.ts` (in apps/web). Do not edit by hand: a test fails when this file and the game disagree. -->',
    '',
    'These are the default keys. Every keyboard action can be rebound in **Settings → Key bindings**, and the game shows your own keys in prompts, hints and the in-game **How to play**. Aim, crouch and interact can each be **hold** or **toggle** (Settings → Controls).',
    '',
    '## Keyboard and mouse',
    '',
    ...desktopControls().flatMap((g) => [`### ${g.group}`, '', table(g.rows), '']),
    '## Touch',
    '',
    'One thumb moves, the other aims and fires. Aim down sights and crouch are toggles on touch. Play in landscape.',
    '',
    table(TOUCH_CONTROLS),
    '',
    '## Field rules',
    '',
    ...FIELD_RULES.map((r) => `- ${r}`),
    '',
  ].join('\n')
}
