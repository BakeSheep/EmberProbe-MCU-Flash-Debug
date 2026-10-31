"use strict";

// Size ceilings against god files and god functions. Counts skip blank lines and comments.
// Ceilings only go down: lower an entry in the commit that shrinks its file, and delete it once the file is back
// under the default. Never raise one to make room for new code; split the code instead.
const MAX_FILE_LINES = 1500;
const MAX_FUNCTION_LINES = 300;
const FILE_LINE_CEILINGS = {
    "src/mainViewProvider.js": 6718,
    "src/webview/liveWatch/renderer.js": 4483,
    "src/webview/sidebar/renderer.js": 3118,
    "src/liveWatch.js": 2155,
    "src/webview/runtime.js": 1543
};
// Webview modules are excluded: their UMD factory function is the whole file.
const FUNCTION_LINE_CEILINGS = {
    "src/dwarf/parser.js": 769,
    "src/mainViewProvider.js": 430,
    "src/dwarf/runtimeTypes.js": 368
};
const sizeOptions = (max) => ({ max, skipBlankLines: true, skipComments: true });

module.exports = [
    {
        ignores: [
            "dist/**",
            "mockup/dist/**",
            "node_modules/**",
            ".vscode-test/**",
            "coverage/**",
            "resources/**",
            ".claude/**"
        ]
    },
    {
        files: ["src/**/*.js", "skills/**/*.js", "scripts/**/*.js", "test/**/*.js", "mockup/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs"
        },
        rules: {
            "constructor-super": "error",
            "for-direction": "error",
            "getter-return": "error",
            "no-async-promise-executor": "error",
            "no-class-assign": "error",
            "no-constant-binary-expression": "error",
            "no-dupe-args": "error",
            "no-dupe-class-members": "error",
            "no-dupe-else-if": "error",
            "no-dupe-keys": "error",
            "no-func-assign": "error",
            "no-import-assign": "error",
            "no-new-native-nonconstructor": "error",
            "no-obj-calls": "error",
            "no-self-assign": "error",
            "no-setter-return": "error",
            "no-unreachable": "error",
            "no-unreachable-loop": "error",
            "no-unsafe-finally": "error",
            "no-unsafe-negation": "error",
            "no-with": "error",
            "require-yield": "error",
            "use-isnan": "error",
            "valid-typeof": "error",
            "no-unused-vars": [
                "error",
                { vars: "all", args: "none", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^_" }
            ]
        }
    },
    {
        // Webview and mock scripts share one global scope per page, so only their locals can be checked.
        files: ["src/webview/**/*.js", "mockup/**/*.js"],
        rules: {
            "no-unused-vars": [
                "error",
                { vars: "local", args: "none", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^_" }
            ]
        }
    },
    {
        files: ["src/**/*.js", "skills/**/*.js", "scripts/**/*.js"],
        rules: { "max-lines": ["error", sizeOptions(MAX_FILE_LINES)] }
    },
    {
        files: ["src/**/*.js", "skills/**/*.js", "scripts/**/*.js"],
        ignores: ["src/webview/**"],
        rules: { "max-lines-per-function": ["error", sizeOptions(MAX_FUNCTION_LINES)] }
    },
    ...Object.entries(FILE_LINE_CEILINGS).map(([file, max]) => ({
        files: [file],
        rules: { "max-lines": ["error", sizeOptions(max)] }
    })),
    ...Object.entries(FUNCTION_LINE_CEILINGS).map(([file, max]) => ({
        files: [file],
        rules: { "max-lines-per-function": ["error", sizeOptions(max)] }
    }))
];
