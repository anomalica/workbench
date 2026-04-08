import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  publicDir: "static",
  resolve: {
    alias: {
      $lib: "/src/lib",
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
