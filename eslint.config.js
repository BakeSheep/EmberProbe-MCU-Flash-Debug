"use strict";

module.exports = [
    {
        ignores: ["dist/**", "node_modules/**", ".vscode-test/**", "coverage/**", "resources/**", ".claude/**"]
    },
    {
        files: ["src/**/*.js", "scripts/**/*.js", "test/**/*.js"],
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
            "valid-typeof": "error"
        }
    }
];
