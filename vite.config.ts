import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// eslint-disable-next-line
// @ts-expect-error - process is available at build time
const isVitest = !!process.env.VITEST;

export default defineConfig({
  plugins: [tailwindcss(), svelte({ hot: !isVitest })],
  publicDir: "static",
  resolve: {
    alias: {
      $lib: "/src/lib",
    },
    // In vitest we need the browser version of Svelte so mount() is available
    ...(isVitest ? { conditions: ["browser"] } : {}),
  },
  server: {
    // 1947 - Roswell, the obvious mnemonic for this archive. Deliberately NOT a
    // near-miss of Vite's default 5173: the previous 5273 differed by one digit
    // and was mistyped as 5173 (which serves a different project entirely), so
    // the port has to be unmistakable, not merely unused. strictPort fails
    // loudly rather than silently incrementing into another app's port.
    port: 1947,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8073",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    server: {
      deps: {
        inline: [/^svelte/],
      },
    },
  },
});
