import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { defaultExecFile } from "../scripts/lib/transport/cli.mjs";

// Exercise the REAL spawn path (no injected execFile) — the security-critical
// code: detached process-group spawn, timeout SIGKILL, maxBuffer overflow,
// ENOENT. Uses local `node` subprocesses only (no model calls, no network).

const baseOpts = { cwd: tmpdir(), input: "", encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, env: process.env };

test("defaultExecFile: resolves stdout on success", async () => {
  const out = await defaultExecFile(process.execPath, ["-e", "process.stdout.write('hello')"], baseOpts);
  assert.equal(out, "hello");
});

test("defaultExecFile: forwards stdin to the child", async () => {
  const out = await defaultExecFile(
    process.execPath,
    ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.toUpperCase()))"],
    { ...baseOpts, input: "abc" },
  );
  assert.equal(out, "ABC");
});

test("defaultExecFile: SIGKILLs a runaway child on timeout", async () => {
  await assert.rejects(
    () => defaultExecFile(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { ...baseOpts, timeout: 150 }),
    (e) => /timed out/.test(e.message),
  );
});

test("defaultExecFile: rejects when stdout exceeds maxBuffer", async () => {
  await assert.rejects(
    () =>
      defaultExecFile(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(5000))"],
        { ...baseOpts, maxBuffer: 1000 },
      ),
    (e) => /maxBuffer/.test(e.message),
  );
});

test("defaultExecFile: rejects on a missing binary (ENOENT)", async () => {
  await assert.rejects(
    () => defaultExecFile("multipoly-definitely-not-a-real-binary-9999", [], baseOpts),
    (e) => e.code === "ENOENT" || /ENOENT|not found|spawn/i.test(e.message),
  );
});

test("defaultExecFile: non-zero exit rejects with stderr attached", async () => {
  await assert.rejects(
    () => defaultExecFile(process.execPath, ["-e", "process.stderr.write('boom');process.exit(3)"], baseOpts),
    (e) => /code 3/.test(e.message) && e.stderr === "boom",
  );
});
