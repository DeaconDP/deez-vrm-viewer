import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    preact(),
    ...(mode === 'desktop' ? [] : [VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'Deez VRM Viewer',
        short_name: 'Deez VRM',
        description: 'A private, local-first VRM avatar inspector.',
        theme_color: '#121417',
        background_color: '#121417',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ],
        file_handlers: [{ action: '.', accept: { 'model/gltf-binary': ['.vrm', '.glb'] } }]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,glb,txt}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024
      }
    })])
  ]
}));
