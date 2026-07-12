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
    // Workbench-specific ports so the dev server never silently collides with
    // another app's Vite (they all default to 5173 and increment, which caused a
    // churn where the loser got SIGTERM'd). strictPort fails loudly instead.
    port: 5273,
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
