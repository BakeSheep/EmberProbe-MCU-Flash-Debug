"use strict";
// A real subprocess speaking MI. Never connects to a probe.
const readline = require("readline");
let breakpoint = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const match = /^(\d+)(.*)$/.exec(line);
    if (!match) return;
    const [, token, command] = match;
    let body = "";
    if (command === "-target-download") {
        process.stdout.write(`${token}+download,{section=".text",section-size="6668",total-size="9880"}\n`);
        process.stdout.write(
            `${token}+download,{section=".text",section-sent="512",section-size="6668",total-sent="512",total-size="9880"}\n`
        );
    }
    if (command.startsWith("-break-insert")) body = `,bkpt={number="${++breakpoint}",addr="0x08000000",line="12"}`;
    if (command === "-thread-info") body = ',threads=[{id="1",name="Cortex-M"}]';
    if (command === "-stack-list-frames")
        body = ',stack=[frame={level="0",func="main",line="12",file="main.c",addr="0x08000000"}]';
    if (command.startsWith("-var-create")) body = ',name="var1",value="3",numchild="0",type="int"';
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
