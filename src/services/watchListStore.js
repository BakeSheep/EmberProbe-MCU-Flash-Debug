"use strict";
class WatchListStore {
    constructor({ state, normalize, symbols, onChanged, onError }) {
        this.state = state;
        this.normalize = normalize;
        this.symbols = symbols;
        this.onChanged = onChanged;
        this.onError = onError;
        this.cache = new Map();
    }
    invalidate(key) {
        if (key === undefined) this.cache.clear();
        else this.cache.delete(key);
        this.onChanged();
    }
    read(key) {
        if (this.cache.has(key)) return this.cache.get(key);
        try {
            const items = this.normalize(this.state.get(key) || [], this.symbols(), key);
            this.cache.set(key, items);
            return items;
        } catch (error) {
            this.onError(error);
            return [];
        }
    }
    async save(key, items) {
        await this.state.update(key, items);
        this.invalidate(key);
    }
    async rebind(keys, symbols) {
        this.invalidate();
        const result = new Map();
        for (const key of new Set(keys)) {
            const previous = this.state.get(key) || [];
            const items = this.normalize(previous, symbols, key);
            if (JSON.stringify(items) !== JSON.stringify(previous)) await this.state.update(key, items);
            this.cache.set(key, items);
            result.set(key, items);
        }
        return result;
    }
}
module.exports = { WatchListStore };
