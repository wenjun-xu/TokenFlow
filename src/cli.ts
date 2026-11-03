#!/usr/bin/env bun
import { start, stop, serviceMain } from "./lifecycle";
import { workerMain, probeMain } from "./query";
import { defaultDB } from "./private";
import { StoreError } from "./store";

export const VERSION = "0.2.1";
const HELP = `TokenFlow：本地只读 Copilot Token 明细

用法：
  tokenflow start [--db <已有 SQLite 数据库路径>] [--no-browser]
  tokenflow stop
  tokenflow --help
  tokenflow --version

默认数据库：~/.copilot/session-store.db
只支持可验证 sandbox-exec 隔离的 macOS。`;
type Hooks = { state?: string; out?: (s: string) => void; err?: (s: string) => void; open?: (url: string) => Promise<boolean> };
export async function openBrowser(url: string): Promise<boolean> {
  let child;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#key=[A-Za-z0-9_-]+$/.test(url)) return false;
    child = Bun.spawn(["/usr/bin/osascript", "-"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    child.stdin.write("open location " + JSON.stringify(url) + "\n"); child.stdin.end();
    const exit = await Promise.race([child.exited, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
    if (exit === null) { child.kill("SIGKILL"); await child.exited; return false; }
    return exit === 0;
  } catch { if (child && child.exitCode === null) child.kill("SIGTERM"); return false; }
  finally { clearTimeout(timer); }
}
export async function main(argv = process.argv.slice(2), hooks: Hooks = {}): Promise<number> {
  const out = hooks.out ?? console.log, err = hooks.err ?? console.error;
  if (argv[0] === "_query" && argv.length === 1) return workerMain();
  if (argv[0] === "_probe" && argv.length === 3) return probeMain(argv[1], argv[2]);
  if (argv[0] === "_serve" && argv.length === 1) return serviceMain();
  if (argv.length === 0 || (argv.length === 1 && ["--help", "-h"].includes(argv[0]))) { out(HELP); return 0; }
  if (argv.length === 1 && argv[0] === "--version") { out(VERSION); return 0; }
  if (argv.length === 2 && argv[0] === "start" && ["--help", "-h"].includes(argv[1])) { out(HELP); return 0; }
  let db = defaultDB(), noBrowser = false;
  if (argv[0] !== "start" && !(argv[0] === "stop" && argv.length === 1)) { err("TokenFlow：命令或参数无效，请执行 tokenflow --help"); return 2; }
  if (argv[0] === "start") {
    let suppliedDB = false;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--no-browser" && !noBrowser) noBrowser = true;
      else if (argv[i] === "--db" && !suppliedDB && argv[i + 1] && !argv[i + 1].startsWith("--")) { db = argv[++i]; suppliedDB = true; }
      else { err("TokenFlow：参数无效，请执行 tokenflow --help"); return 2; }
    }
  }
  try {
    if (argv[0] === "stop") { out(await stop(hooks.state) ? "TokenFlow 已停止" : "TokenFlow 未运行"); return 0; }
    const [info, reused] = await start(db, hooks.state);
    const url = `http://127.0.0.1:${info.port}/#key=${info.token}`;
    out(reused ? "TokenFlow 已复用现有实例" : "TokenFlow 已启动"); out(url);
    if (!noBrowser && !await (hooks.open ?? openBrowser)(url)) err("无法打开默认浏览器；服务仍在运行，请手动打开上方完整地址");
    return 0;
  } catch (error) {
    err("TokenFlow：" + (error instanceof StoreError || error instanceof Error && !("code" in error)
      ? error.message : "本地操作失败，请检查安装、状态目录权限和数据源"));
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main();
