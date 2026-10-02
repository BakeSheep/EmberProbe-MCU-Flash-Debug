"use strict";

// Opt-in native GDB integration. Normal tests need neither a compiler nor hardware.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { EmberDebugSession } = require("../../src/debug/session");
const { MiClient, quote } = require("../../src/debug/mi");
const { initializePrettyPrinting } = require("../../src/services/prettyPrinting");

(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cpp-native-gdb-")));
    const gdb = process.env.CPP_GDB || "gdb";
    const compiler = process.env.CPP_CXX || "g++";
    const dwarf = process.env.CPP_DWARF || "5";
    const standard = process.env.CPP_STANDARD || "17";
    assert(["4", "5"].includes(dwarf));
    assert(["17", "20"].includes(standard));
    const executable = path.join(root, process.platform === "win32" ? "cpp.exe" : "cpp");
    const mi = new MiClient();
    const adapter = new EmberDebugSession({ mi });
    adapter.setRunAsServer(true);
    const output = [];
    adapter.sendEvent = (event) => {
        if (event.event === "output") output.push(event.body.output);
    };
    async function stopAt(command) {
        let timer, listener;
        const stopped = new Promise((resolve, reject) => {
            listener = (record) => {
                if (record.kind === "*" && record.class === "stopped") resolve(record);
            };
            mi.on("record", listener);
            timer = setTimeout(() => reject(new Error("Native GDB stop timed out: " + output.join(""))), 15000);
        });
        try {
            await mi.command(command);
            await stopped;
        } finally {
            clearTimeout(timer);
            mi.off("record", listener);
        }
    }
    const evaluate = (expression) => adapter.handle("evaluate", { expression });
    const expand = (variable, args = {}) =>
        adapter
            .handle("variables", {
                variablesReference: variable.variablesReference,
                ...args
            })
            .then((result) => result.variables);
    async function leaves(variable, depth = 0) {
        if (!variable.variablesReference || depth === 6) return [variable.value ?? variable.result];
        const result = [];
        for (const child of await expand(variable)) result.push(...(await leaves(child, depth + 1)));
        return result;
    }
    async function classMembers(variable, depth = 0) {
        assert(depth < 12, "bounded C++ class traversal");
        const result = [];
        for (const child of await expand(variable)) {
            if (child.variablesReference) result.push(...(await classMembers(child, depth + 1)));
            else result.push({ ...child, parent: variable.variablesReference });
        }
        return result;
    }
    try {
        console.log(execFileSync(compiler, ["--version"], { encoding: "utf8", windowsHide: true }).split("\n")[0]);
        console.log(execFileSync(gdb, ["--version"], { encoding: "utf8", windowsHide: true }).split("\n")[0]);
        execFileSync(
            compiler,
            [
                `-std=c++${standard}`,
                "-g",
                `-gdwarf-${dwarf}`,
                "-O0",
                path.resolve(__dirname, "../fixtures/cpp-paused.cpp"),
                path.resolve(__dirname, "../fixtures/cpp-scopes-second.cpp"),
                "-o",
                executable
            ],
            { windowsHide: true }
        );
        mi.start(gdb, root);
        await mi.command("-gdb-set mi-async on");
        await mi.command("-gdb-set pagination off");
        await mi.command("-gdb-set confirm off");
        assert(
            await initializePrettyPrinting(mi, { gdbPath: gdb, enablePrettyPrinting: true }, (message) =>
                output.push(message)
            ),
            output.join("")
        );
        await mi.command(`-file-exec-and-symbols ${quote(executable.replace(/\\/g, "/"))}`);
        await mi.command('-break-insert "checkpoint"');
        adapter.ready = true;
        adapter.threads.add(1);
        await stopAt("-exec-run");

        const contextFrames = (await adapter.handle("stackTrace", { threadId: 1, levels: 2 })).stackFrames;
        const contextScopes = (await adapter.handle("scopes", { frameId: contextFrames[0].id })).scopes;
        const contextDirectory = await adapter.symbolDirectory.variables("globals");
        const counterIndex = contextDirectory.findIndex((item) => item.name === "reviewCounter");
        assert(counterIndex >= 0);
        const counter = (await expand(contextScopes[1], { start: counterIndex, count: 1 }))[0];
        assert.strictEqual(counter.value, "100", "Globals must bypass the same-named parameter");
        await adapter.handle("setVariable", {
            variablesReference: contextScopes[1].variablesReference,
            name: counter.name,
            value: "101"
        });
        assert.strictEqual((await evaluate("::reviewCounter")).result, "101");
        assert.strictEqual((await evaluate("reviewCounter")).result, "7", "global edits must not write the parameter");
        for (const mode of ["builtin", "raw"]) {
            adapter.config.prettyPrintingMode = mode;
            const local = await adapter.handle("evaluate", { frameId: contextFrames[0].id, expression: "p" });
            const expected = await mi.command('-data-evaluate-expression "(unsigned long long)&p.x"');
            await adapter.selectFrame(contextFrames[1].id);
            const fields = await classMembers(local);
            const member = fields.find((item) => item.name === "x");
            assert.strictEqual(member.value, "22");
            assert.strictEqual(BigInt(member.memoryReference), BigInt(expected.value), `${mode}: owning-frame address`);
        }
        delete adapter.config.prettyPrintingMode;
        await adapter.selectFrame(contextFrames[0].id);

        const classes = await classMembers(await evaluate("classObject"));
        const repeated = classes.filter((item) => item.name === "repeated");
        assert.deepStrictEqual(repeated.map((item) => item.value).sort(), ["11", "21", "31"]);
        assert(
            repeated.every((item) => item.evaluateName && item.memoryReference),
            JSON.stringify({
                repeated,
                paths: await Promise.all(
                    [...adapter.variableStore.nodes.values()]
                        .filter((node) => node.item.exp === "repeated")
                        .map(async (node) => ({
                            name: node.item.name,
                            path: await mi.command(`-var-info-path-expression ${quote(node.item.name)}`)
                        }))
                )
            })
        );
        assert.strictEqual(new Set(repeated.map((item) => item.memoryReference)).size, 3);
        const leftMember = repeated.find((item) => item.value === "11");
        assert.strictEqual(
            (
                await adapter.handle("setVariable", {
                    variablesReference: leftMember.parent,
                    name: "repeated",
                    value: "71"
                })
            ).value,
            "71"
        );
        assert.strictEqual((await evaluate("classObject.ClassLeft::repeated")).result, "71");
        assert.strictEqual((await evaluate("classObject.ClassRight::repeated")).result, "21");
        assert.strictEqual((await evaluate("classObject.repeated")).result, "31");
        assert.strictEqual(
            (await adapter.handle("setExpression", { expression: leftMember.evaluateName, value: "72" })).value,
            "72"
        );
        assert.strictEqual((await evaluate("classObject.ClassLeft::repeated")).result, "72");
        assert.strictEqual((await evaluate("classObject.ClassRight::repeated")).result, "21");
        assert(classes.some((item) => item.name === "anonymousInt" && item.value === "41"));
        assert(classes.some((item) => item.name === "anonymousNested" && item.value === "51"));
        assert(classes.some((item) => item.name === "privateValue" && item.presentationHint.visibility === "private"));
        assert(
            classes.some((item) => item.name === "protectedValue" && item.presentationHint.visibility === "protected")
        );
        assert(
            (await classMembers(await evaluate("polymorphic"))).some(
                (item) => item.name === "derivedOnly" && item.value === "32"
            ),
            "GDB resolves paused RTTI to the derived class"
        );
        const virtualMembers = await classMembers(await evaluate("virtualObject"));
        assert(
            virtualMembers.some((item) => item.name === "virtualValue" && item.value === "61"),
            "GDB resolves virtual base offsets: " + JSON.stringify(virtualMembers)
        );
        const constMembers = await classMembers(await evaluate("constClassObject"));
        const constField = constMembers.find((item) => item.name === "derivedOnly");
        assert(constField.presentationHint.attributes.includes("readOnly"));
        await assert.rejects(
            adapter.handle("setVariable", { variablesReference: constField.parent, name: constField.name, value: "0" }),
            /read only/
        );

        assert.match((await evaluate("shortText")).result, /hello/);
        assert.match((await evaluate("longText")).result, /xxxxxxxx|repeats 128 times/);
        assert.strictEqual((await evaluate("emptyText")).variablesReference, 0);
        assert.deepStrictEqual(
            (await expand(await evaluate("linkedValues"))).map((item) => item.value),
            ["1", "2", "3"]
        );
        assert.deepStrictEqual(
            (await expand(await evaluate("forwardValues"))).map((item) => item.value),
            ["4", "5", "6"]
        );
        const deque = await evaluate("dequeValues");
        assert.strictEqual(deque.indexedVariables, 259);
        assert.deepStrictEqual(
            (await expand(deque, { start: 125, count: 5 })).map((item) => item.value),
            ["126", "127", "128", "129", "130"]
        );
        assert.deepStrictEqual(await leaves(await evaluate("weakValue")), ["19"]);
        assert.strictEqual((await evaluate("expiredWeak")).variablesReference, 0);
        for (const [name, expected] of [
            ["setValues", ["1", "2", "3"]],
            ["multiSetValues", ["1", "2", "2"]],
            ["hashSetValues", ["7", "8"]],
            ["hashMultiSetValues", ["7", "7", "8"]]
        ]) {
            const container = await evaluate(name);
            const values = await expand(container);
            assert.deepStrictEqual(values.map((item) => item.value).sort(), expected);
            assert(values.every((item) => item.presentationHint.attributes.includes("readOnly")));
            await assert.rejects(
                adapter.handle("setVariable", {
                    variablesReference: container.variablesReference,
                    name: values[0].name,
                    value: "0"
                }),
                /read only/
            );
        }
        for (const name of ["multiMapValues", "hashMultiMapValues"]) {
            const entries = await expand(await evaluate(name));
            assert.strictEqual(entries.length, 2);
            const values = [];
            for (const item of entries) values.push((await leaves(item)).join(":"));
            assert.deepStrictEqual(values.sort(), name === "multiMapValues" ? ["1:10", "1:11"] : ["1:20", "1:21"]);
        }
        for (const name of ["emptyList", "emptyForward", "emptyDeque", "emptySet", "emptyHashSet"])
            assert.strictEqual((await evaluate(name)).variablesReference, 0, name);
        const longString = await evaluate("longText");
        let characterPage = await expand(longString),
            characterCount = 0;
        for (;;) {
            const more = characterPage.at(-1)?.name === "More…" ? characterPage.at(-1) : null;
            characterCount += characterPage.length - (more ? 1 : 0);
            if (!more) break;
            characterPage = await expand(more);
        }
        assert.strictEqual(characterCount, 512);
        assert.strictEqual((await evaluate("emptyVector")).variablesReference, 0);
        const numbers = await evaluate("numbers");
        assert.match(numbers.result, /length 300/);
        const first = await expand(numbers);
        assert.strictEqual(first.length, 101);
        assert.strictEqual(first[0].value, "0");
        const second = await expand(first.at(-1));
        assert.strictEqual(second[0].value, "100");
        const third = await expand(second.at(-1));
        assert.strictEqual(third.length, 100);
        assert.strictEqual(third.at(-1).value, "299");
        await adapter.handle("setVariable", {
            variablesReference: numbers.variablesReference,
            name: first[0].name,
            value: "41"
        });
        assert.strictEqual((await expand(numbers, { start: 0, count: 1 }))[0].value, "41");
        assert.deepStrictEqual(await leaves(await evaluate("fixed")), ["4", "5", "6"]);
        for (const name of ["pairValue", "tupleValue"])
            assert.strictEqual((await expand(await evaluate(name))).length, 2);
        const ordered = await expand(await evaluate("ordered"));
        assert.strictEqual(ordered.length, 2);
        const entry = await expand(ordered[0]);
        assert.strictEqual(entry[0].value, "1");
        assert(entry[0].presentationHint.attributes.includes("readOnly"));
        assert.deepStrictEqual(
            (await expand(entry[1])).map((child) => child.value),
            ["11", "12"]
        );
        const unordered = await expand(await evaluate("unordered"));
        assert.strictEqual(unordered.length, 2);
        const values = [];
        for (const item of unordered) values.push((await expand(item))[1].value);
        assert(values.some((value) => value.includes("three")) && values.some((value) => value.includes("four")));
        for (const [name, value] of [
            ["uniqueValue", "17"],
            ["sharedValue", "19"],
            ["present", "23"],
            ["choice", "29"]
        ]) {
            const values = await leaves(await evaluate(name));
            assert(values.includes(value), `${name} did not expose ${value}: ${JSON.stringify(values)}`);
        }
        assert.strictEqual((await evaluate("absent")).variablesReference, 0);
        const emptyPointer = await evaluate("emptyPointer");
        const pointerChildren = emptyPointer.variablesReference ? await expand(emptyPointer) : [];
        assert(pointerChildren.length === 0 || pointerChildren.some((child) => /0x0|nullptr/.test(child.value)));
        for (const name of ["emptyMap", "emptyHash", "emptyShared", "emptyArray", "emptyTuple"])
            assert.strictEqual((await evaluate(name)).variablesReference, 0, name);
        assert.match((await evaluate("embeddedNul")).result, /a\\u0000b/);
        assert.strictEqual((await expand(await evaluate("repeatedTuple"))).length, 3);
        assert.deepStrictEqual(
            (await expand(await evaluate("aliasNumbers"))).map((item) => item.value),
            ["31", "32"]
        );
        assert.deepStrictEqual(await leaves(await evaluate("nestedOptional")), ["51", "52"]);
        const constVector = await evaluate("constNumbers");
        const owner = await evaluate("constOwner");
        assert(!(await expand(owner))[0].presentationHint);
        await adapter.handle("setVariable", {
            variablesReference: owner.variablesReference,
            name: "value",
            value: "42"
        });
        assert.strictEqual((await expand(owner))[0].value, "42");
        const pointee = await evaluate("constPointee");
        assert((await expand(pointee))[0].presentationHint.attributes.includes("readOnly"));
        await assert.rejects(
            adapter.handle("setVariable", {
                variablesReference: pointee.variablesReference,
                name: "value",
                value: "44"
            }),
            /read only/
        );
        assert((await expand(constVector))[0].presentationHint.attributes.includes("readOnly"));
        await assert.rejects(
            adapter.handle("setVariable", {
                variablesReference: constVector.variablesReference,
                name: "[0]",
                value: "9"
            }),
            /read only/
        );
        const boolVector = await evaluate("bits");
        assert.strictEqual(boolVector.indexedVariables, 205);
        const bit = (await expand(boolVector, { start: 100, count: 1 }))[0];
        assert.strictEqual(bit.value, "false");
        assert(bit.presentationHint.attributes.includes("readOnly"));
        const largeMap = await evaluate("manyPairs");
        const mapFirst = await expand(largeMap);
        const mapSecond = await expand(mapFirst.at(-1));
        const mapThird = await expand(mapSecond.at(-1));
        assert.strictEqual(mapThird.length, 5);
        assert.strictEqual((await expand(mapThird.at(-1)))[1].value, "214");
        for (const [name, expected] of [
            ["keyedMap", "61"],
            ["keyedHash", "63"]
        ]) {
            const keyed = (await expand(await evaluate(name)))[0];
            const parts = await expand(keyed);
            assert.strictEqual(parts[1].value, expected);
            const keyCharacters = await expand(parts[0]);
            assert(keyCharacters[0].presentationHint.attributes.includes("readOnly"));
            await assert.rejects(
                adapter.handle("setVariable", {
                    variablesReference: parts[0].variablesReference,
                    name: "[0]",
                    value: "65"
                }),
                /read only/
            );
        }

        const rawPointer = await evaluate("rawPointer");
        assert(rawPointer.presentationHint.attributes.includes("readOnly"));
        const rawPointee = (await expand(rawPointer))[0];
        assert(!rawPointee.presentationHint, "the pointee of int* const remains writable");
        await adapter.handle("setVariable", {
            variablesReference: rawPointer.variablesReference,
            name: rawPointee.name,
            value: "8"
        });
        assert.strictEqual((await evaluate("rawValue")).result, "8");
        let ownerMember = (await expand(await evaluate("rawOwner")))[0];
        if (ownerMember.name === "public") ownerMember = (await expand(ownerMember))[0];
        assert(!(await expand(ownerMember))[0].presentationHint);
        const readonlyRawPointer = await evaluate("readonlyRawPointer");
        const readonlyRawPointee = (await expand(readonlyRawPointer))[0];
        await assert.rejects(
            adapter.handle("setVariable", {
                variablesReference: readonlyRawPointer.variablesReference,
                name: readonlyRawPointee.name,
                value: "9"
            })
        );

        await adapter.clearVariables();
        await stopAt("-exec-continue");
        await assert.rejects(expand(numbers), /Stale/);
        const changed = await evaluate("numbers");
        assert.strictEqual((await expand(changed, { count: 1 }))[0].value, "1");
        assert.strictEqual((await expand(changed, { start: 299, count: 1 }))[0].value, "300");
        assert((await expand(await evaluate("choice"))).some((child) => child.value.includes("changed")));

        const frame = (await adapter.handle("stackTrace", { threadId: 1, levels: 1 })).stackFrames[0];
        const scopes = (await adapter.handle("scopes", { frameId: frame.id })).scopes;
        assert.strictEqual(scopes.length, 4);
        const directory = await adapter.symbolDirectory.variables("globals");
        const shortTextIndex = directory.findIndex((item) => item.name === "shortText");
        assert(shortTextIndex >= 0);
        const globals = (await expand(scopes[1], { start: shortTextIndex, count: 1 })).filter(
            (item) => item.name === "shortText"
        );
        assert.strictEqual(globals.length, 1);
        assert.strictEqual(globals[0].evaluateName, "::shortText");
        assert.match(globals[0].memoryReference, /^0x[\da-f]+$/i);
        const statics = await expand(scopes[2]);
        assert.strictEqual(statics.find((item) => item.name === "scopeCounter")?.value, "13");
        const secondFile = path.resolve(__dirname, "../fixtures/cpp-scopes-second.cpp").replace(/\\/g, "/");
        assert.strictEqual((await evaluate(`'${secondFile}'::scopeCounter`)).result, "27");
        const registers = await expand(scopes[3]);
        const pc = registers.find((item) => ["pc", "rip", "eip"].includes(item.name));
        assert(pc && pc.evaluateName === `$${pc.name}`);
        assert.strictEqual(
            (await adapter.handle("setExpression", { frameId: frame.id, expression: "scopeCounter", value: "17" }))
                .value,
            "17"
        );
        assert.strictEqual(
            (await evaluate(`'${secondFile}'::scopeCounter`)).result,
            "27",
            "the other translation unit stays independent"
        );
        const registerFrame = (await adapter.handle("stackTrace", { threadId: 1, levels: 1 })).stackFrames[0];
        const registerScope = (await adapter.handle("scopes", { frameId: registerFrame.id })).scopes[3];
        const preserved = (await expand(registerScope)).find((item) => item.name === pc.name);
        const registerWrite = await adapter.handle("setVariable", {
            variablesReference: registerScope.variablesReference,
            name: pc.name,
            value: preserved.value
        });
        assert.strictEqual(BigInt(registerWrite.value), BigInt(preserved.value));
        console.log(
            `Native GCC/libstdc++ + GDB C++${standard} DWARF ${dwarf}: wrappers, nested maps, paging, writes and resume passed`
        );
    } catch (error) {
        console.error(output.join(""));
        const diagnostics = path.resolve(__dirname, "../../test-results");
        fs.mkdirSync(diagnostics, { recursive: true });
        fs.writeFileSync(path.join(diagnostics, `cpp-gdb-dwarf-${dwarf}.log`), output.join("") + "\n" + error.stack);
        throw error;
    } finally {
        const closed =
            mi.process && mi.process.exitCode === null
                ? new Promise((resolve) => {
                      mi.process.once("close", resolve);
                  })
                : Promise.resolve();
        await mi.stop();
        await closed;
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
