import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "dist-test/**", "node_modules/**", ".vscode-test/**", "bin/**", "*.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // core/, mcp/ and cli/ run outside the editor (agents, CI); they must not import vscode.
    files: ["src/core/**/*.ts", "src/mcp/**/*.ts", "src/cli/**/*.ts", "src/chat/protocol.ts", "src/chat/crypto.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "vscode", message: "core/mcp/cli must stay editor-independent." }] }],
    },
  },
);
