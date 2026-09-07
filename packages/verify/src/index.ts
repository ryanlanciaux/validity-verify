export { runInit } from './commands/init.js';
export { runDoctor } from './commands/doctor.js';

// Re-exports for users who add `validity` as a local devDependency and
// want typed config authoring:
//   import { defineConfig, type ValidityConfig } from 'validity';
export { defineConfig } from '@validity.ai/verify-spec';
export type { ValidityConfig } from '@validity.ai/verify-spec';
