# @validity.ai/verify-plugin-vite

Vite plugin that writes `.validity/app-manifest.json` so isolated verify can
mirror env, PostCSS/Tailwind, and aliases.

```ts
import validity from '@validity.ai/verify-plugin-vite';

export default defineConfig({
  plugins: [react(), validity()],
});
```

Run `vite dev` once. Commit the manifest. Env values are never recorded.
