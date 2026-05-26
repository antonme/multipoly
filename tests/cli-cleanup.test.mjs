import { test } from "node:test";
import assert from "node:assert/strict";
import { installGroupCleanup } from "../scripts/lib/transport/cli.mjs";

// A fake process: captures registered handlers so a test can fire them
// synchronously, without touching the real process or real OS signals.
function fakeProc() {
  const handlers = {};
  return {
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
      return this;
    },
    emit(event, ...args) {
      for (const fn of handlers[event] || []) fn(...args);
    },
    events() {
      return Object.keys(handlers);
    },
  };
}

test("installGroupCleanup: registers exit, beforeExit, SIGINT and SIGTERM", () => {
  const proc = fakeProc();
  installGroupCleanup(new Set(), { proc, killGroup: () => {}, exit: () => {} });
  for (const ev of ["exit", "beforeExit", "SIGINT", "SIGTERM"]) {
    assert.ok(proc.events().includes(ev), `expected a ${ev} handler`);
  }
});

test("installGroupCleanup: SIGTERM kills every tracked group then exits 143", () => {
  const proc = fakeProc();
  const killed = [];
  const exited = [];
  const groups = new Set([111, 222]);
  installGroupCleanup(groups, { proc, killGroup: (pgid) => killed.push(pgid), exit: (c) => exited.push(c) });

  proc.emit("SIGTERM");
  assert.deepEqual(killed.sort(), [111, 222]);
  assert.deepEqual(exited, [143]); // 128 + SIGTERM(15)
  assert.equal(groups.size, 0, "tracked groups are cleared after cleanup");
});

test("installGroupCleanup: SIGINT exits with code 130", () => {
  const proc = fakeProc();
  const exited = [];
  installGroupCleanup(new Set([5]), { proc, killGroup: () => {}, exit: (c) => exited.push(c) });
  proc.emit("SIGINT");
  assert.deepEqual(exited, [130]); // 128 + SIGINT(2)
});

test("installGroupCleanup: exit/beforeExit kill groups but never re-exit", () => {
  const proc = fakeProc();
  const killed = [];
  const exited = [];
  installGroupCleanup(new Set([7]), { proc, killGroup: (p) => killed.push(p), exit: (c) => exited.push(c) });
  proc.emit("exit");
  assert.deepEqual(killed, [7]);
  assert.deepEqual(exited, [], "exit handler must not call exit() again (no loop)");
});

test("installGroupCleanup: one group's kill error does not abort the rest", () => {
  const proc = fakeProc();
  const killed = [];
  const exited = [];
  const killGroup = (pgid) => {
    killed.push(pgid);
    if (pgid === 1) throw new Error("ESRCH: already gone");
  };
  installGroupCleanup(new Set([1, 2]), { proc, killGroup, exit: (c) => exited.push(c) });
  proc.emit("SIGTERM");
  assert.deepEqual(killed.sort(), [1, 2], "second group still killed after first throws");
  assert.deepEqual(exited, [143]);
});
