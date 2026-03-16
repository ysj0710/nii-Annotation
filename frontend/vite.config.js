import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@niivue/dcm2niix']
  },
  worker: {
    format: 'es'
  },
  server: {
    host: '0.0.0.0',
    strictPort: false
  }
})
