import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs: YouTube Playables serves the uploaded bundle from a
  // nested path, so absolute /assets/... links would 404. Vercel is fine
  // with relative paths too.
  base: './',
});
