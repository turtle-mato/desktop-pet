import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

export function tsLoader(stubs = {}, globals = {}) {
  const cache = new Map();
  function load(file) {
    file = resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const source = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const require = (name) => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (!name.startsWith(".")) {
        if (name.startsWith("node:")) return createRequire(file)(name);
        throw Error(`Unmocked dependency: ${name} (${file})`);
      }
      const base = resolve(dirname(file), name);
      const target = extname(base) ? base : existsSync(base + ".ts") ? base + ".ts" : resolve(base, "index.ts");
      return load(target);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require, console,
      AbortController, AbortSignal, setTimeout, clearTimeout, ...globals }, { filename: file });
    return module.exports;
  }
  return load;
}

export const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
export function fakeDate(time) {
  return class extends Date {
    constructor(...args) { super(...(args.length ? args : [time()])); }
    static now() { return time(); }
  };
}
