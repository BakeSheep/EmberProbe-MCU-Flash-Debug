"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { scenario } = require("./helpers/scenario");
const project2 = require("../src/services/cubemx2Project");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/cubemx2/c593.ioc2"), "utf8");
const store = (file, value) => `"File: ${file}" = """\n${JSON.stringify(value, null, 2)}"""\n`;
const description = '["Project Description"]\nworkingAreaId = "wa-1"\nversion = "1"\nmx2Version = "1.2.0"\n';

(async () => {
    await scenario("Parse the TOML subset of a real STM32C593RET6 project and summarize it", () => {
        const parsed = project2.parseIoc2(fixture);
        assert.strictEqual(parsed.description.mx2Version, "1.2.0");
        assert.strictEqual(parsed.files.size, 20);
        for (const [file, text] of parsed.files) if (file.endsWith(".json")) JSON.parse(text);
        const summary = project2.summarize(parsed, "C:/work/c593.ioc2");
        assert.deepStrictEqual(
            { chip: summary.chip, projectName: summary.projectName, version: summary.cubemx2Version },
            { chip: "STM32C593RET6", projectName: "c593", version: "1.2.0" }
        );
        assert.deepStrictEqual(
            summary.peripherals.map((item) => item.name),
            ["MPU", "ICACHE", "RCC", "NVIC"]
        );
        assert.deepStrictEqual(summary.pins, []);
        assert.strictEqual(summary.format, "");
    });

    await scenario("Decode TOML strings and reject unsafe or unsupported content", () => {
        const text =
            '# comment\n"File: a/b.json" = """\n{"q": "x"}"""\n' +
            '"File: e.txt" = """a \\"q\\" \\t \\u00e9 \\\\ ""end"""" \n' +
            '"File: lit.hw" = \'""\'\n' +
            "\"File: multi.yml\" = '''\nkey: 'v'\n'''\n" +
            description;
        const parsed = project2.parseIoc2(Buffer.from("\uFEFF" + text));
        assert.deepStrictEqual(JSON.parse(parsed.files.get("a/b.json")), { q: "x" });
        assert.strictEqual(parsed.files.get("e.txt"), 'a "q" \t é \\ ""end"');
        assert.strictEqual(parsed.files.get("lit.hw"), '""');
        assert.strictEqual(parsed.files.get("multi.yml"), "key: 'v'\n");
        for (const bad of [
            '"File: ../x.json" = """{}"""\n' + description,
            '"File: C:/x.json" = """{}"""\n' + description,
            '"File: /x.json" = """{}"""\n' + description,
            '"File: a//x.json" = """{}"""\n' + description,
            '"File: x.json" = """{}"""\n"File: x.json" = """{}"""\n' + description,
            '"File: x.json" = """{}\n' + description,
            '"File: x.json" = 12\n' + description,
            '"File: x.json" = """{}""" extra\n' + description,
            '"File: x.json" = """{}"""\n',
            description,
            "[bad header\n" + description
        ])
            assert.throws(() => project2.parseIoc2(bad), { code: "CUBEMX2_PROJECT_INVALID" }, bad);
        assert.throws(() => project2.parseIoc2(Buffer.alloc(project2.MAX_IOC2_BYTES + 1, 32)), {
            code: "CUBEMX2_PROJECT_INVALID"
        });
    });

    await scenario("Report semantic changes by section and key arrays by element id", () => {
        const before = project2.parseIoc2(
            store("project/.settings/peripherals.store.json", { configuration: { RCC: {} } }) +
                store(".settings/clock.store.json", {
                    userSettings: [
                        { id: "SYSCLK", value: 1 },
                        { id: "HCLK", value: 2 }
                    ]
                }) +
                store(".settings/nvic.store.json", { b: 1, a: 2 }) +
                description
        );
        const after = project2.parseIoc2(
            store("project/.settings/peripherals.store.json", {
                configuration: { RCC: {}, USART1: { mode: "Async" } }
            }) +
                store(".settings/clock.store.json", {
                    userSettings: [
                        { id: "ETH", value: 9 },
                        { id: "SYSCLK", value: 1 },
                        { id: "HCLK", value: 3 }
                    ]
                }) +
                // Key order alone is not a change.
                store(".settings/nvic.store.json", { a: 2, b: 1 }) +
                '"File: project/x.cproject.yml" = """\nproject: {}\n"""\n' +
                description
        );
        const changes = project2.changes(before, after);
        assert.deepStrictEqual(
            changes.map((item) => [item.section, item.action, item.path]),
            [
                ["clock", "modified", "userSettings[id=ETH]"],
                ["clock", "modified", "userSettings[id=HCLK].value"],
                ["peripherals", "modified", "configuration.USART1"],
                ["other", "added", undefined]
            ]
        );
        const groups = project2.categorize(changes);
        assert.strictEqual(groups.clock.length, 2);
        assert.strictEqual(groups.nvic.length, 0);
        assert.strictEqual(project2.section("x/.settings/dma.store.json"), "dma");
        assert.strictEqual(project2.changes(before, after, 1).length, 1);
    });

    await scenario("Give staged copies their own working area and restore the original id", () => {
        const staged = project2.withWorkingArea(fixture, "11111111-2222-3333-4444-555555555555");
        assert.strictEqual(
            project2.parseIoc2(staged).description.workingAreaId,
            "11111111-2222-3333-4444-555555555555"
        );
        const original = project2.parseIoc2(fixture).description.workingAreaId;
        assert.strictEqual(project2.withWorkingArea(staged, original), fixture);
        assert.match(project2.newWorkingAreaId(), /^[0-9a-f-]{36}$/);
        assert.throws(() => project2.withWorkingArea('"File: x" = """{}"""\n', "id"), {
            code: "CUBEMX2_PROJECT_INVALID"
        });
    });

    await scenario("Read CubeMX2 file groups and compare the generation record without its timestamp", () => {
        const record = (timestamp, files) => Buffer.from(JSON.stringify({ version: "1.0.0", timestamp, files }));
        const groups = project2.exportedGroups(
            record("t1", [
                { file: "main.c", fileGroup: "user_code" },
                { file: "generated\\hal\\mx_rcc.c", fileGroup: "generated" }
            ])
        );
        assert.deepStrictEqual(
            [...groups],
            [
                ["main.c", "user_code"],
                ["generated/hal/mx_rcc.c", "generated"]
            ]
        );
        for (const bad of [
            "{",
            JSON.stringify({ files: {} }),
            JSON.stringify({ files: [{ file: "../x", fileGroup: "pack" }] })
        ])
            assert.throws(() => project2.exportedGroups(Buffer.from(bad)), { code: "CUBEMX2_OUTPUT_INVALID" });
        const entry = (bytes) => ({ bytes, hash: require("crypto").createHash("sha256").update(bytes).digest("hex") });
        const first = entry(record("t1", []));
        const second = entry(record("t2", []));
        assert.strictEqual(project2.sameContent(".settings/exported-files.json", first, second), true);
        assert.strictEqual(project2.sameContent("other.json", first, second), false);
        assert.strictEqual(project2.sameContent("main.c", undefined, undefined), true);
        assert.strictEqual(project2.sameContent("main.c", first, undefined), false);
        assert.ok(project2.OWNED_GROUPS.has("pack") && project2.USER_GROUPS.has("RTE"));
    });

    console.log("CubeMX2 project parsing, summaries, semantic changes and file groups passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
