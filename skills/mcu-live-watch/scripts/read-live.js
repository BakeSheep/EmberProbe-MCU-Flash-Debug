"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

const TYPES = new Set(["u8", "i8", "u16", "i16", "u32", "i32", "f32"]);
const WIDTH = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4 };

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (name === "list" || name === "trend" || name === "read") out[name] = true;
    else {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
      out[name] = value;
    }
  }
  return out;
}

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function variableSpecs(value) {
  const specs = String(value || "").split(",").filter(Boolean).map(raw => {
    const trimmed = raw.trim();
    // 路径语法（结构体成员 sensor.x / 数组元素 buf[0] / 范围 buf[1:5] / 全部 buf[*]）
    // 类型由扩展侧按 DWARF 布局推断，整体作为变量名传递，不再按 ':' 拆分类型。
    if (trimmed.includes("[") || trimmed.includes(".")) {
      if (!trimmed) throw new Error("Variable name is required");
      return { name: trimmed };
    }
    const split = trimmed.lastIndexOf(":");
    const name = (split > 0 ? trimmed.slice(0, split) : trimmed).trim();
    const type = split > 0 ? trimmed.slice(split + 1).trim() : "";
    if (!name) throw new Error("Variable name is required");
    if (type && !TYPES.has(type)) throw new Error(`Unsupported variable type: ${type}`);
    return type ? { name, type } : { name };
  });
  if (!specs.length) throw new Error("Pass --variables name[,name...]");
  return specs;
}

function newestElf(root) {
  let best = null;
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".elf")) {
        const mtime = fs.statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: full, mtime };
      }
    }
  };
  visit(root);
  return best && best.path;
}

function parseSymbolsBuffer(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (b.length < 52 || b.toString("latin1", 1, 4) !== "ELF" || b[4] !== 1 || b[5] !== 1) {
    throw new Error("Only ELF32 little-endian firmware is supported");
  }
  const shoff = b.readUInt32LE(32), shentsize = b.readUInt16LE(46) || 40, shnum = b.readUInt16LE(48);
  if (shentsize < 40 || !shoff || !shnum || shoff + shnum * shentsize > b.length) {
    throw new Error("ELF section table is out of bounds");
  }
  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (o + 40 > b.length) break;
    sections.push({ type: b.readUInt32LE(o + 4), offset: b.readUInt32LE(o + 16), size: b.readUInt32LE(o + 20), link: b.readUInt32LE(o + 24), entsize: b.readUInt32LE(o + 36) });
  }
  const sym = sections.find(s => s.type === 2) || sections.find(s => s.type === 11);
  if (!sym || !sections[sym.link]) throw new Error("ELF has no usable symbol table");
  const str = sections[sym.link], result = [], seen = new Set(), ent = sym.entsize || 16;
  const inBounds = s => s.offset <= b.length && s.size <= b.length - s.offset;
  if (!inBounds(sym) || !inBounds(str) || ent < 16) throw new Error("ELF symbol table is out of bounds");
  const cstr = p => {
    const endLimit = str.offset + str.size;
    if (p < str.offset || p >= endLimit) return "";
    let e = p;
    while (e < endLimit && b[e]) e++;
    return e < endLimit ? b.toString("utf8", p, e) : "";
  };
  for (let o = sym.offset; o + 16 <= Math.min(b.length, sym.offset + sym.size); o += ent) {
    if ((b[o + 12] & 15) !== 1) continue;
    const section = b.readUInt16LE(o + 14), address = b.readUInt32LE(o + 4) >>> 0;
    if (!section || section === 0xfff1 || !address) continue;
    const name = cstr(str.offset + b.readUInt32LE(o));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push({ name, address, size: b.readUInt32LE(o + 8) >>> 0 });
  }
  return result.sort((a, z) => a.name.localeCompare(z.name));
}
function readStableElf(file) {
  const before = fs.statSync(file);
  const buffer = fs.readFileSync(file);
  const after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("ELF changed while being read; retry after the build finishes");
  }
  return {
    buffer,
    size: after.size,
    mtimeMs: after.mtimeMs,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex")
  };
}
function parseSymbols(file) {
  const snapshot = readStableElf(file);
  return { symbols: parseSymbolsBuffer(snapshot.buffer), snapshot };
}

function infer(size) { return size === 1 ? "u8" : size === 2 ? "u16" : size === 4 ? "u32" : ""; }
function decode(values, type) {
  const buf = Buffer.from(values.slice(0, WIDTH[type]));
  if (buf.length < WIDTH[type]) return null;
  if (type === "u8") return buf.readUInt8(0);
  if (type === "i8") return buf.readInt8(0);
  if (type === "u16") return buf.readUInt16LE(0);
  if (type === "i16") return buf.readInt16LE(0);
  if (type === "u32") return buf.readUInt32LE(0);
  if (type === "i32") return buf.readInt32LE(0);
  return buf.readFloatLE(0);
}
function memoryValues(text) {
  return String(text).replace(/\x1a/g, " ").replace(/(^|\s)(0x)?[0-9a-f]+:/gi, " ").trim().split(/\s+/).flatMap(t => {
    const value = /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
    return Number.isInteger(value) && value >= 0 && value <= 255 ? [value] : [];
  });
}

function summarize(points) {
  if (!points.length) return { samples: 0, direction: "unknown" };
  const valid = points.filter(point => Number.isFinite(point.value));
  const values = valid.map(point => point.value);
  if (!values.length) return { samples: points.length, direction: "unknown" };
  const first = values[0], last = values[values.length - 1];
  const min = Math.min(...values), max = Math.max(...values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const t0 = valid[0].timestamp;
  const xs = valid.map(point => (point.timestamp - t0) / 1000);
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  let numerator = 0, denominator = 0, turns = 0, previousSign = 0;
  for (let i = 0; i < values.length; i++) {
    numerator += (xs[i] - xMean) * (values[i] - mean);
    denominator += (xs[i] - xMean) ** 2;
    if (i) {
      const sign = Math.sign(values[i] - values[i - 1]);
      if (sign && previousSign && sign !== previousSign) turns++;
      if (sign) previousSign = sign;
    }
  }
  const slopePerSecond = denominator ? numerator / denominator : 0;
  const span = max - min;
  const tolerance = Math.max(Math.abs(mean) * 0.001, 1e-9);
  let direction = "stable";
  if (turns >= Math.max(2, Math.floor(values.length / 3)) && span > tolerance * 2) direction = "volatile";
  else if (Math.abs(last - first) > tolerance) direction = slopePerSecond > 0 ? "rising" : "falling";
  return {
    samples: points.length, validSamples: valid.length, first, last, min, max, mean,
    delta: last - first,
    percentChange: first === 0 ? null : ((last - first) / Math.abs(first)) * 100,
    slopePerSecond,
    direction
  };
}

class Tcl {
  constructor(port) { this.port = port; this.socket = null; this.pending = ""; this.queue = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const s = this.socket = net.connect({ host: "127.0.0.1", port: this.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error("Tcl connection timeout"));
      }, 5000);
      const onConnect = () => {
        clearTimeout(timer);
        s.removeListener("error", onInitialError);
        resolve();
      };
      const onInitialError = error => {
        clearTimeout(timer);
        s.removeListener("connect", onConnect);
        reject(error);
      };
      s.setNoDelay(true); s.once("connect", onConnect); s.once("error", onInitialError);
      s.on("error", error => { while (this.queue.length) this.queue.shift().reject(error); });
      s.on("data", chunk => {
        this.pending += chunk.toString("latin1");
        let i;
        while ((i = this.pending.indexOf("\x1a")) >= 0) {
          const value = this.pending.slice(0, i); this.pending = this.pending.slice(i + 1);
          const q = this.queue.shift(); if (q) q.resolve(value);
        }
      });
      s.on("close", () => { while (this.queue.length) this.queue.shift().reject(new Error("Tcl connection closed")); });
    });
  }
  command(text) {
    return new Promise((resolve, reject) => {
      const item = { resolve, reject };
      const timer = setTimeout(() => { this.socket.destroy(); reject(new Error("Tcl response timeout")); }, 2000);
      item.resolve = value => { clearTimeout(timer); resolve(value); };
      item.reject = error => { clearTimeout(timer); reject(error); };
      this.queue.push(item); this.socket.write(text + "\x1a");
    });
  }
  close() { if (this.socket) this.socket.destroy(); }
}

async function main() {
  const opt = args(process.argv.slice(2));
  const workspace = path.resolve(opt.workspace || process.cwd());
  // 趋势读取同样走扩展桥：已有采样时复用连接；未采样时由扩展临时启动
  // OpenOCD，并把启动、进度和关闭状态同步到侧边栏。只输出汇总，减少 Agent token。
  if (opt.trend && !opt.elf && !opt.port) {
    const variables = variableSpecs(opt.variables);
    if (!variables.length) throw new Error("Pass --variables name[:type],...");
    const count = boundedInteger(opt.count, 10, 2, 1000, "--count");
    const intervalMs = boundedInteger(opt.interval, 200, 20, 60000, "--interval");
    if (opt["add-to"]) {
      const types = Object.fromEntries(variables.filter(item => item.type).map(item => [item.name, item.type]));
      await call(workspace, "watch.add", {
        variables: variables.map(item => item.name),
        types,
        destination: opt["add-to"]
      });
    }
    const result = await call(workspace, "variables.sample", {
      variables,
      count,
      intervalMs
    }, Math.min(2147483647, count * intervalMs + 30000));
    const series = {};
    for (const sample of result.samples || []) {
      for (const [name, item] of Object.entries(sample.values || {})) {
        (series[name] ||= []).push({ timestamp: sample.timestamp, value: item.value });
      }
    }
    const latest = result.samples?.length ? result.samples[result.samples.length - 1].values : {};
    process.stdout.write(JSON.stringify({
      type: "trend",
      source: result.source,
      elf: result.elf,
      sampleCount: result.samples?.length || 0,
      latest,
      trends: Object.fromEntries(Object.entries(series).map(([name, points]) => [name, summarize(points)]))
    }) + "\n");
    return;
  }
  // 最常见路径只需变量名：扩展自动从最新 ELF/DWARF 推断类型，并选择复用
  // 当前采样连接或临时启动探针读取一次。无需 Agent 搜索源码或要求用户先点“开始”。
  if (!opt.list && !opt.trend && opt.count === undefined && !opt["add-to"] && !opt.elf && !opt.port) {
    const result = await call(workspace, "variables.read", { variables: variableSpecs(opt.variables) });
    process.stdout.write(JSON.stringify({ type: "sample", ...result }) + "\n");
    return;
  }
  const selectedElf = opt.elf || newestElf(workspace);
  if (!selectedElf) throw new Error("No ELF found; pass --elf or --workspace");
  const elf = path.resolve(selectedElf);
  if (!fs.existsSync(elf)) throw new Error(`ELF does not exist: ${elf}`);
  const parsed = parseSymbols(elf);
  const symbols = parsed.symbols;
  const snapshot = parsed.snapshot;
  if (opt.list) {
    for (const s of symbols) process.stdout.write(JSON.stringify({ elf, elfSha256: snapshot.sha256, elfMtimeMs: snapshot.mtimeMs, ...s, inferredType: infer(s.size), compositeCandidate: s.size > 4 }) + "\n");
    return;
  }
  const requested = String(opt.variables || "").split(",").filter(Boolean).map(spec => {
    const split = spec.lastIndexOf(":");
    const name = split > 0 ? spec.slice(0, split) : spec;
    const explicit = split > 0 ? spec.slice(split + 1) : "";
    const symbol = symbols.find(s => s.name === name);
    if (!symbol) throw new Error(`Variable not found in ELF: ${name}`);
    const type = explicit || infer(symbol.size);
    if (!TYPES.has(type)) throw new Error(`Variable ${name} is ${symbol.size} bytes; specify a scalar type or read a member/element instead`);
    return { ...symbol, type };
  });
  if (!requested.length) throw new Error("Pass --variables name[:type],...");
  if (opt["add-to"]) {
    const destination = opt["add-to"];
    const types = Object.fromEntries(requested.map(item => [item.name, item.type]));
    const added = await call(workspace, "watch.add", { variables: requested.map(item => item.name), types, destination });
    process.stdout.write(JSON.stringify({ type: "watchUpdate", destination, ...added }) + "\n");
    if (!opt.read && !opt.trend && opt.count === undefined) return;
  }
  const tcl = new Tcl(boundedInteger(opt.port, 6666, 1, 65535, "--port"));
  try {
    await tcl.connect();
    const count = boundedInteger(opt.count, opt.trend ? 10 : 1, 1, 1000000, "--count");
    const interval = boundedInteger(opt.interval, 200, 20, 60000, "--interval");
    const series = Object.fromEntries(requested.map(item => [item.name, []]));
    for (let sample = 0; sample < count; sample++) {
      const current = fs.statSync(elf);
      if (current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs) {
        const error = new Error("ELF changed during sampling; start a new sampling run to rebind variable addresses");
        error.code = "ELF_CHANGED";
        throw error;
      }
      const timestamp = Date.now(), values = {};
      for (const v of requested) {
        const suffix = `0x${v.address.toString(16)} 8 ${WIDTH[v.type]}`;
        let raw = await tcl.command(`ocd_read_memory ${suffix}`), bytes = memoryValues(raw);
        if (bytes.length < WIDTH[v.type]) { raw = await tcl.command(`read_memory ${suffix}`); bytes = memoryValues(raw); }
        values[v.name] = { value: decode(bytes, v.type), type: v.type, address: `0x${v.address.toString(16)}` };
        series[v.name].push({ timestamp, value: values[v.name].value });
      }
      process.stdout.write(JSON.stringify({ type: "sample", elf, elfSha256: snapshot.sha256, elfMtimeMs: snapshot.mtimeMs, timestamp, values }) + "\n");
      if (sample + 1 < count) await new Promise(resolve => setTimeout(resolve, interval));
    }
    if (opt.trend) {
      process.stdout.write(JSON.stringify({
        type: "trend", elf, elfSha256: snapshot.sha256,
        trends: Object.fromEntries(Object.entries(series).map(([name, points]) => [name, summarize(points)]))
      }) + "\n");
    }
  } finally { tcl.close(); }
}

if (require.main === module) main().catch(error => {
  const argv = process.argv.slice(2);
  const operation = argv.includes("--trend") ? "variables.trend" : (argv.includes("--list") ? "variables.list" : "variables.read");
  writeDiagnostic(error, { operation });
  process.exitCode = 1;
});
module.exports = { args, boundedInteger, variableSpecs, parseSymbolsBuffer, memoryValues, decode, infer, readStableElf, summarize };
