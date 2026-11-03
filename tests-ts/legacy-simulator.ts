import { dlopen, FFIType } from "bun:ffi";
import { chmodSync, closeSync, constants, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const [state, input, mode] = process.argv.slice(2);
const db = resolve(input);
const descriptor = openSync(join(state, "lock"), constants.O_CREAT | constants.O_RDWR, 0o600);
const native = dlopen("/usr/lib/libSystem.B.dylib", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
if (native.symbols.flock(descriptor, 2 | 4) !== 0) throw new Error("Synthetic legacy lock unavailable");
if (mode === "hold") {
  console.log("ready");
  await Bun.sleep(60000);
} else {
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("legacy synthetic") });
  const metadata = statSync(db);
  const info = {
    identity: "legacy-synthetic-identity", token: "legacy-synthetic-token", db,
    file_identity: [metadata.dev, metadata.ino], port: http.port, pid: process.pid,
  };
  let stop: () => void = () => {};
  const finished = new Promise<void>(resolve => { stop = resolve; });
  const controller = createServer({ allowHalfOpen: true }, socket => {
    let data = "";
    socket.on("data", chunk => { data += chunk.toString(); });
    socket.on("end", () => {
      const request = JSON.parse(data);
      if (request.identity !== info.identity || !["stop", "status"].includes(request.command)) {
        socket.destroy(); return;
      }
      socket.end(JSON.stringify({ ok: true, identity: info.identity, busy: false }), () => {
        if (request.command === "stop") stop();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    controller.once("error", reject);
    controller.listen(join(state, "c"), resolve);
  });
  chmodSync(join(state, "c"), 0o600);
  writeFileSync(join(state, "state.json"), JSON.stringify(info), { mode: 0o600 });
  console.log("ready");
  await finished;
  await http.stop(true);
  await new Promise<void>(resolve => controller.close(() => resolve()));
  unlinkSync(join(state, "state.json"));
}
closeSync(descriptor);
native.close();
