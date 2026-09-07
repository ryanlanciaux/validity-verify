import { defineConfig } from '@validity.ai/verify-spec';

export default defineConfig({
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.gen.tsx',
  mockNetwork: {
    handlers: [
      { method: 'POST', url: '/api/contact', status: 200, json: { ok: true } },
    ],
  },
  components: {
    'src/components/ContactForm.tsx': {},
  },
});
