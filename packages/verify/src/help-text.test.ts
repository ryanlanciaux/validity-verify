import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_TEXT } from './help-text.js';

const here = dirname(fileURLToPath(import.meta.url));
const helpMdPath = resolve(here, '../skill/validity/HELP.md');

describe('HELP_TEXT', () => {
  it('matches packages/verify/skill/validity/HELP.md byte-for-byte', () => {
    const onDisk = readFileSync(helpMdPath, 'utf-8');
    expect(onDisk).toBe(HELP_TEXT);
  });
});
