// 仅供 tsc 静态检查用（思维系统本身零依赖，不装 @types/node）。
// 目的：把 Node 内置模块和全局变量都声明成 any，
// 这样 tsc 输出里剩下的错误就都是"真问题"——比如本地模块之间漏 import、名字写错，
// 这类错以前会让某个接口在运行时直接 500（/v1/messages/recent 就这么坏掉的）。

// Node 内置模块：通配符简写声明，全部当成 any
declare module "node:*";

// Node 全局变量
declare var process: any;
declare var Buffer: any;
declare var console: any;
declare var global: any;
declare var setTimeout: any;
declare var clearTimeout: any;
declare var setInterval: any;
declare var clearInterval: any;
declare var setImmediate: any;
declare var fetch: any;
declare var performance: any;
declare var TextDecoder: any;
declare var TextEncoder: any;

// Node 24 的 import.meta.dirname / filename
interface ImportMeta {
  dirname: string;
  filename: string;
}
