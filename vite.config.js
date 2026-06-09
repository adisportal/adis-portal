import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // 1. Crucial: Disable source maps so your real code can't be reconstructed
    sourcemap: false, 
    rollupOptions: {
      output: {
        // 2. Split your code into distinct hidden chunks
        manualChunks(id) {
          if (id.includes('node_modules')) {
            return 'vendor'; // Puts all external libraries in one file
          }
          if (id.includes('src/components/admin')) {
            return 'admin-portal'; // Admin specific code isolated
          }
          if (id.includes('src/components/attendance')) {
            return 'attendance-core'; // Attendance system isolated
          }
        },
        // 3. Obfuscate the filenames so attackers don't know what chunk is what
        chunkFileNames: 'assets/js/[hash].js',
        entryFileNames: 'assets/js/[hash].js',
      }
    }
  }
});
