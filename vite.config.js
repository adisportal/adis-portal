import { defineConfig } from 'vite';
import obfuscator from 'vite-plugin-javascript-obfuscator';

export default defineConfig({
  build: {
    sourcemap: false, // CRITICAL: This hides your original code from DevTools
    outDir: 'dist',   // This is the folder Render will deploy
  },
  plugins: [
    obfuscator({
      compact: true,
      controlFlowFlattening: true, // Scrambles execution logic
      stringArrayEncoding: ['base64'], // Encrypts text strings
    }),
  ],
});
