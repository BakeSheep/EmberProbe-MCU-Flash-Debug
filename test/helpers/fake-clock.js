"use strict";
class FakeClock {
    constructor() {
        this.time = 1000;
        this.seq = 0;
        this.tasks = new Map();
    }
    now = () => this.time;
    schedule = (fn, ms) => {
        const id = ++this.seq;
        this.tasks.set(id, { at: this.time + ms, fn });
        return id;
    };
    cancel = (id) => this.tasks.delete(id);
    async advance(ms) {
        const end = this.time + ms;
        // Flush nested promise continuations before selecting the next timer.
        for (let count = 0; count < 10000; count++) {
            for (let i = 0; i < 20; i++) await Promise.resolve();
            const next = [...this.tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) {
                this.time = end;
                return;
            }
            this.time = next[1].at;
            this.tasks.delete(next[0]);
            next[1].fn();
        }
        throw Error("Fake clock runaway timers");
    }
}
module.exports = { FakeClock };
