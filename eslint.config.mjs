import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "assets/auth-adapter.bundle.js",
      "playwright-report/**",
      "test-results/**",
      ".agents/**",
    ],
  },
  {
    // Reglas base requeridas en el proyecto
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-undef": "error",
      "eqeqeq": "error",
      "no-implicit-globals": "error",
    },
  },
  {
    // Cliente del navegador (archivos en la raíz)
    files: ["*.js", "*.mjs"],
    ignores: ["server.mjs", "playwright.config.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
  },
  {
    // Entorno Node.js para servidor, scripts y configuraciones
    files: [
      "server/**",
      "server.mjs",
      "scripts/**",
      "playwright.config.mjs",
      "eslint.config.mjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Pruebas (Node.js test runner y Playwright)
    files: ["tests/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
];
