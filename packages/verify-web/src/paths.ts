import { resolve, relative } from 'node:path';

export function validityDir(projectRoot: string): string {
  return resolve(projectRoot, 'node_modules', '.validity');
}

export function entryFile(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'entry.tsx');
}

export function indexHtml(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'index.html');
}

export function propsDir(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'props');
}

export function propsFile(projectRoot: string, id: string): string {
  return resolve(propsDir(projectRoot), `${id}.json`);
}

export function relFromValidity(projectRoot: string, absolute: string): string {
  return relative(validityDir(projectRoot), absolute).replaceAll('\\', '/');
}
