import { defineConfig } from 'vite';

export default defineConfig({
  // Relative, because the plugin serves the page under a secret path prefix.
  base: './',
  // Loaded lazily when gestures are first enabled; without this, Vite discovers it
  // at that moment and reloads the page, cancelling the action.
  optimizeDeps: { include: ['@mediapipe/tasks-vision'] },
});
