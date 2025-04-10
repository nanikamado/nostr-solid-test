import tailwindcss from "@tailwindcss/vite";
import { defineConfig, PluginOption } from "vite";
import solid from "vite-plugin-solid";
import solidSvg from "vite-plugin-solid-svg";

export default defineConfig({
  plugins: [tailwindcss() as PluginOption, solid() as PluginOption, solidSvg()],
  base: "./",
});
