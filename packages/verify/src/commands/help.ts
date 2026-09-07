import { HELP_TEXT } from '../help-text.js';

/**
 * `validity help` prints a curated, skill-sized reference. The skill (in
 * `~/.claude/skills/validity/SKILL.md`) shells out to this command when the
 * user types `/validity help` (or `/validity` with no args), so the bytes
 * come from the binary, not the model. The same string is mirrored in
 * `packages/skill/validity/HELP.md` for environments where the CLI isn't on
 * PATH.
 */
export function runHelp(): void {
  process.stdout.write(HELP_TEXT);
}
