import { defineConfig } from "vite";
import { resolve } from "path";

// 시뮬(index.html)과 트랙 에디터(editor.html)를 별도 엔트리로 처리.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        editor: resolve(__dirname, "editor.html"),
      },
    },
  },
});
