"use strict";
const Icon = require("../webview/liveWatch/backgroundIcon");
const KEY = "emberprobe.chartBackgroundIcon.v1";

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
        const value = icon === null ? undefined : Icon.validate(icon);
        const write = this.pending
            .catch(() => {})
            .then(async () => {
                if (!this.state) throw new Error("Background storage unavailable");
                await this.state.update(KEY, value);
                return value || null;
            });
        this.pending = write.then(
            () => {},
            () => {}
        );
        return write;
    }
}
module.exports = { ChartBackgroundStore };
