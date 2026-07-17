"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");

const TYPES = new Set(["u8", "i8", "u16", "i16", "u32", "i32", "f32"]);
const WIDTH = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4 };

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    if (name === "list") out.list = true;
    else out[name] = argv[++i];
  }
  return out;
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
  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (o + 40 > b.length) break;
    sections.push({ type: b.readUInt32LE(o + 4), offset: b.readUInt32LE(o + 16), size: b.readUInt32LE(o + 20), link: b.readUInt32LE(o + 24), entsize: b.readUInt32LE(o + 36) });
  }
  const sym = sections.find(s => s.type === 2) || sections.find(s => s.type === 11);
  if (!sym || !sections[sym.link]) throw new Error("ELF has no usable symbol table");
  const str = sections[sym.link], result = [], seen = new Set(), ent = sym.entsize || 16;
  const cstr = p => { let e = p; while (e < b.length && b[e]) e++; return b.toString("utf8", p, e); };
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
function parseSymbols(file) { return parseSymbolsBuffer(fs.readFileSync(file)); }

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
  return String(text).replace(/\x1a/g, " ").replace(/(^|\s)(0x)?[0-9a-f]+:/gi, " ").trim().split(/\s+/).flatMap(t => /^0x[0-9a-f]+$/i.test(t) ? [parseInt(t, 16)] : /^-?\d+$/.test(t) ? [parseInt(t, 10)] : []);
}

class Tcl {
  constructor(port) { this.port = port; this.socket = null; this.pending = ""; this.queue = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const s = this.socket = net.connect({ host: "127.0.0.1", port: this.port });
      s.setNoDelay(true); s.once("connect", resolve); s.once("error", reject);
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
  const selectedElf = opt.elf || newestElf(workspace);
  if (!selectedElf) throw new Error("No ELF found; pass --elf or --workspace");
  const elf = path.resolve(selectedElf);
  if (!fs.existsSync(elf)) throw new Error(`ELF does not exist: ${elf}`);
  const symbols = parseSymbols(elf);
  if (opt.list) {
    for (const s of symbols) process.stdout.write(JSON.stringify({ elf, ...s, inferredType: infer(s.size), compositeCandidate: s.size > 4 }) + "\n");
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
  const tcl = new Tcl(Math.max(1, Number(opt.port) || 6666));
  try {
    await tcl.connect();
    const count = Math.max(1, Number(opt.count) || 1), interval = Math.max(20, Number(opt.interval) || 200);
    for (let sample = 0; sample < count; sample++) {
      const timestamp = Date.now(), values = {};
      for (const v of requested) {
        const suffix = `0x${v.address.toString(16)} 8 ${WIDTH[v.type]}`;
        let raw = await tcl.command(`ocd_read_memory ${suffix}`), bytes = memoryValues(raw);
        if (bytes.length < WIDTH[v.type]) { raw = await tcl.command(`read_memory ${suffix}`); bytes = memoryValues(raw); }
        values[v.name] = { value: decode(bytes, v.type), type: v.type, address: `0x${v.address.toString(16)}` };
      }
      process.stdout.write(JSON.stringify({ elf, timestamp, values }) + "\n");
      if (sample + 1 < count) await new Promise(resolve => setTimeout(resolve, interval));
    }
  } finally { tcl.close(); }
}

if (require.main === module) main().catch(error => { process.stderr.write(JSON.stringify({ error: error.message }) + "\n"); process.exitCode = 1; });
module.exports = { parseSymbolsBuffer, memoryValues, decode, infer };
