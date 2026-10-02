"use strict";
// A real subprocess speaking MI. Never connects to a probe.
const readline = require("readline");
let breakpoint = 0;
let autoLoadDisabled = false;
const numbers = new Map();
const vectorFields = {
    "numbers._M_impl._M_start": "0x20001000",
    "numbers._M_impl._M_finish": "0x20001334",
    "numbers._M_impl._M_end_of_storage": "0x20001334"
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const match = /^(\d+)(.*)$/.exec(line);
    if (!match) return;
    const [, token, command] = match;
    if (command === "-gdb-set auto-load off") autoLoadDisabled = true;
    if (command.startsWith("-file-exec-and-symbols") && !autoLoadDisabled) {
        process.stdout.write(`${token}^error,msg="Auto-loading must be disabled before loading ELF"\n`);
        return;
    }
    if (/python|enable-pretty-printing|var-set-visualizer|register_libstdcxx/.test(command)) {
        process.stdout.write(`${token}^error,msg="Python is unavailable in this fixture"\n`);
        return;
    }
    let body = "";
    if (command === "-target-download") {
        process.stdout.write(`${token}+download,{section=".text",section-size="6668",total-size="9880"}\n`);
        process.stdout.write(
            `${token}+download,{section=".text",section-sent="512",section-size="6668",total-sent="512",total-size="9880"}\n`
        );
    }
    if (command.startsWith("-break-insert")) body = `,bkpt={number="${++breakpoint}",addr="0x08000000",line="12"}`;
    if (command === "-thread-info") body = ',threads=[{id="1",name="Cortex-M"}]';
    if (command.startsWith("-stack-list-frames"))
        body = ',stack=[frame={level="0",func="main",line="12",file="main.c",addr="0x08000000"}]';
    if (command === "-stack-list-variables --simple-values")
        body = ',variables=[{name="counter",type="int",value="3"},{name="numbers",type="std::vector<int>"}]';
    if (command.startsWith("-var-create")) body = ',name="var1",value="3",numchild="0",type="int"';
    if (command.startsWith("-var-create") && command.endsWith('"numbers"'))
        body = ',name="numbers",value="{...}",numchild="1",type="std::vector<int, std::allocator<int> >"';
    if (command === "-list-features") body = ",features=[]";
    if (command.startsWith("-var-info-path-expression")) {
        const name = JSON.parse(command.slice(command.indexOf('"')));
        body = `,path_expr=${JSON.stringify(name)}`;
    }
    if (command.startsWith("-interpreter-exec console")) {
        const consoleCommand = JSON.parse(command.slice(command.indexOf('"')));
        const output =
            consoleCommand === "show endian"
                ? "The target endianness is little endian.\n"
                : "type = std::vector<int, std::allocator<int> >\n";
        process.stdout.write(`~${JSON.stringify(output)}\n`);
    }
    if (command.startsWith("-data-evaluate-expression")) body = ',value="4"';
    const page = /^-var-list-children --all-values "numbers" (\d+) (\d+)$/.exec(command);
    if (page) {
        body =
            ',children=[child={name="numbers._M_impl",exp="_M_impl",numchild="3",type="std::_Vector_base<int>::_Vector_impl"}]';
    }
    if (command.startsWith('-var-list-children --all-values "numbers._M_impl"'))
        body = `,children=[${Object.entries(vectorFields)
            .map(
                ([name, value]) =>
                    `child={name="${name}",exp="${name.split(".").at(-1)}",value="${value}",numchild="0",type="int *"}`
            )
            .join(",")}]`;
    const cast = /^-var-create.*"\*\(\(int\*\)0x([\da-f]+)\)"$/.exec(command);
    const element = cast && [cast[0], String((Number.parseInt(cast[1], 16) - 0x20001000) / 4)];
    if (element)
        body = `,name="element${element[1]}",value="${numbers.get(Number(element[1])) ?? element[1]}",numchild="0",type="int"`;
    const evaluated = /^-var-evaluate-expression "([^"]+)"$/.exec(command);
    if (evaluated) {
        const name = evaluated[1];
        body = `,value=${JSON.stringify(vectorFields[name] || String(numbers.get(Number(name.slice(7))) ?? Number(name.slice(7))))}`;
    }
    if (command.startsWith("-var-show-attributes")) body = ',attr="editable"';
    const assign = /^-var-assign "element(\d+)" "(\d+)"$/.exec(command);
    if (assign) {
        numbers.set(Number(assign[1]), Number(assign[2]));
        body = `,value="${assign[2]}"`;
    }
    if (command.startsWith("-data-read-memory-bytes")) body = ',memory=[{begin="0x20000000",contents="01020304"}]';
    process.stdout.write(`${token}^done${body}\n`);
    if (command.startsWith("-exec-") && !command.includes("interrupt")) {
        process.stdout.write('*running,thread-id="all"\n');
        setTimeout(() => process.stdout.write('*stopped,reason="breakpoint-hit",thread-id="1"\n'), 30);
    }
    if (command.includes("interrupt"))
        process.stdout.write('*stopped,reason="signal-received",signal-name="SIGINT",thread-id="1"\n');
    if (command === "-gdb-exit") process.exit(0);
});
