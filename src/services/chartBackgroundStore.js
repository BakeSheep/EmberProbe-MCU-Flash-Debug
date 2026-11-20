"use strict";
const Icon = require("../webview/liveWatch/backgroundIcon");
const KEY = "emberprobe.chartBackgroundIcon.v1";
const ENABLED_KEY = "emberprobe.chartBackgroundIcon.visibility";

class ChartBackgroundStore {
    constructor(state) {
        this.state = state;
        this.pending = Promise.resolve();
    }
    read() {
        try {
            return Icon.validate(this.state?.get(KEY));
        } catch {
            return null;
        }
    }
    update(icon) {
        return this.write(KEY, icon === null ? undefined : Icon.validate(icon));
    }
    enabled() {
        return this.state?.get(ENABLED_KEY);
    }
    setEnabled(enabled) {
        return this.write(ENABLED_KEY, enabled);
    }
    write(key, value) {
        const write = this.pending
            .catch(() => {})
            .then(async () => {
                if (!this.state) throw new Error("Background storage unavailable");
                await this.state.update(key, value);
                return value ?? null;
            });
        this.pending = write.then(
            () => {},
            () => {}
        );
        return write;
    }
}
module.exports = { ChartBackgroundStore };
