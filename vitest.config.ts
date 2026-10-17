import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const src = (pkg: string) => path.join(root, 'packages', pkg, 'src', 'index.ts');
const appSrc = (app: string) => path.join(root, 'apps', app, 'src', 'index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@omni/kernel': src('kernel'),
      '@omni/memory': src('memory'),
      '@omni/plugin-spec': src('plugin-spec'),
      '@omni/channels': src('channels'),
      '@omni/sandbox': src('sandbox'),
      '@omni/channels-telegram': src('channels-telegram'),
      '@omni/channels-whatsapp': src('channels-whatsapp'),
      '@omni/scheduler': src('scheduler'),
      '@omni/skills': src('skills'),
      '@omni/web': appSrc('web'),
      '@omni/teams': src('teams'),
      '@omni/registry': src('registry'),
      '@omni/importers': src('importers'),
      '@omni/watchers': src('watchers'),
      '@omni/packs': src('packs'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
