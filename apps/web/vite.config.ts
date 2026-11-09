import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { parseEnv } from 'node:util'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// shadcn-vue components declare props with imported types (defineProps<SelectRootProps>()). The SFC
// compiler resolves those through the TypeScript JS API, which pnpm's strict layout hides from it.
// TypeScript is pinned to 6.x because 7.x (the Go port) has no JS API.
const require = createRequire(import.meta.url)
const compiler = require('vue/compiler-sfc')
compiler.registerTS(() => require('typescript'))

// The API's port, from your shell or else the repo's .env (as the server reads it), so the proxy finds it.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url))
const apiPort = process.env.API_PORT ?? (existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, 'utf8')).API_PORT : undefined) ?? 8787

export default defineConfig({
  plugins: [
    vue({ compiler }),
    tailwindcss(),
    VitePWA({
      // Ask before swapping in a new version so a half-filled form is never lost.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Spending Tracker',
        short_name: 'Spending',
        description: 'Track your spending, accounts and net worth.',
        lang: 'en-CA',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#171717',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          {
            name: 'Add transaction',
            short_name: 'Add',
            url: '/add',
            icons: [{ src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' }],
          },
          { name: 'Transactions', url: '/transactions', icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/index.html',
        // The API is always live data; never serve it from the cache. The server's own pages (the
        // ChatGPT sign-in's return, MCP, the health check) aren't the app's either.
        navigateFallbackDenylist: [/^\/api\//, /^\/auth\//, /^\/mcp(\/|$)/, /^\/healthz$/],
        runtimeCaching: [{ urlPattern: /^\/api\//, handler: 'NetworkOnly' }],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // PORT when dev tooling picks one (the API reads API_PORT, so the two don't clash).
    port: Number(process.env.PORT) || 5173,
    // On every interface, so a phone on your network can open it.
    host: true,
    // The names it answers to, besides localhost and IP addresses: local ones and Tailscale's, plus
    // any in VITE_ALLOWED_HOSTS (comma-separated, a leading dot allows subdomains), e.g. a tunnel.
    // Any other name could be a site whose DNS points at your machine (DNS rebinding).
    allowedHosts: [
      'localhost',
      '.localhost',
      '.local',
      '.ts.net',
      ...(process.env.VITE_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
    ],
    // The Host header stays the page's (the shorthand form changes it to localhost), so the API can
    // tell its own page from another site when it's opened at a LAN address, say from a phone.
    proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false } },
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
})
