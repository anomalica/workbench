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
    proxy: {
      "/api": "http://localhost:8000",
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
