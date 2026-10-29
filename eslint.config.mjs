/**
 * Flat ESLint config. The parser and plugins come from the fixed, read-only
 * Pi Pocket checkout, so this project never installs a shared dependency.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { productionRoot } from "./scripts/tools.mjs";

const require = createRequire(join(productionRoot, "package.json"));
const stylistic = require("@stylistic/eslint-plugin");
const prettier = require("eslint-config-prettier/flat");
const tseslint = require("typescript-eslint");

export default [
    {
        ignores: [
            ".runtime/**",
            ".runtime-*/**",
            ".work/**",
            "node_modules/**",
            "upstream.lock.json",
        ],
    },
    {
        files: ["**/*.ts"],
        languageOptions: { parser: tseslint.parser },
    },
    {
        files: ["**/*.{js,mjs,cjs,ts}"],
        plugins: { "@stylistic": stylistic },
        rules: {
            curly: ["error", "all"],
            eqeqeq: ["error", "smart"],
            "no-eval": "error",
            "no-new-func": "error",
            "no-var": "error",
            "prefer-const": ["error", { destructuring: "all" }],
            "no-restricted-properties": [
                "error",
                {
                    object: "document",
                    property: "write",
                    message: "Never write raw HTML from LayerFS data.",
                },
            ],
            "no-restricted-syntax": [
                "error",
                {
                    selector: "AssignmentExpression[left.property.name='innerHTML']",
                    message: "Never set innerHTML from LayerFS data.",
                },
                {
                    selector: "AssignmentExpression[left.name='innerHTML']",
                    message: "Never set innerHTML from LayerFS data.",
                },
                {
                    selector: "Property[key.name='dangerouslySetInnerHTML']",
                    message: "Never set raw HTML from LayerFS data.",
                },
                {
                    selector: "CallExpression[callee.name='eval']",
                    message: "eval is forbidden.",
                },
                {
                    selector: "NewExpression[callee.name='Function']",
                    message: "new Function is forbidden.",
                },
            ],
        },
    },
    {
        files: ["src/pocket-layerfs/*.js"],
        rules: {
            "no-restricted-globals": [
                "error",
                "fetch",
                "XMLHttpRequest",
                "WebSocket",
                "EventSource",
                "importScripts",
            ],
        },
    },
    {
        files: ["src/**/*.{ts,js}", "service/**/*.mjs"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        {
                            name: "node:child_process",
                            message: "The plugin and service must not run a child process.",
                        },
                        {
                            name: "child_process",
                            message: "The plugin and service must not run a child process.",
                        },
                    ],
                },
            ],
        },
    },
    prettier,
];
