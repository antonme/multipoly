import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { containPath, isBinaryFile, readFileCapped, getSize } from "../scripts/lib/fs-safe.mjs";

async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "glm-fs-")));
  await mkdir(path.join(root, "sub"), { recursive: true });
  await writeFile(path.join(root, "a.txt"), "hello\n");
  await writeFile(path.join(root, "sub", "b.txt"), "world\n");
  // binary-ish: contains NUL byte
  await writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 4, 5, 6]));
  // big file for cap testing
  await writeFile(path.join(root, "big.txt"), "x".repeat(1024));
  return root;
}

test("fs-safe: containPath accepts file inside root", async () => {
  const root = await setup();
  const resolved = await containPath(root, "a.txt", { cwd: root });
  assert.equal(resolved, path.join(root, "a.txt"));
});

test("fs-safe: containPath rejects path outside root", async () => {
  const root = await setup();
  await assert.rejects(
    () => containPath(root, "../../../../etc/passwd", { cwd: root }),
    (e) => e.code === "FS",
  );
});

test("fs-safe: containPath rejects symlink escape", async () => {
  const root = await setup();
  const outside = await mkdtemp(path.join(tmpdir(), "glm-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "leak");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  await assert.rejects(
    () => containPath(root, "link.txt", { cwd: root }),
    (e) => e.code === "FS",
  );
});

test("fs-safe: isBinaryFile detects NUL bytes", async () => {
  const root = await setup();
  assert.equal(await isBinaryFile(path.join(root, "bin.dat")), true);
  assert.equal(await isBinaryFile(path.join(root, "a.txt")), false);
});

test("fs-safe: readFileCapped returns overCap for oversize", async () => {
  const root = await setup();
  const r = await readFileCapped(path.join(root, "big.txt"), 100);
  assert.equal(r.overCap, true);
  assert.equal(r.content, null);
  assert.equal(r.size, 1024);
});

test("fs-safe: readFileCapped returns content when within cap", async () => {
  const root = await setup();
  const r = await readFileCapped(path.join(root, "a.txt"), 100);
  assert.equal(r.overCap, false);
  assert.equal(r.content, "hello\n");
});

test("fs-safe: getSize on file", async () => {
  const root = await setup();
  assert.equal(await getSize(path.join(root, "a.txt")), "hello\n".length);
});

test("fs-safe: getSize throws on directory", async () => {
  const root = await setup();
  await assert.rejects(
    () => getSize(path.join(root, "sub")),
    (e) => e.code === "FS",
  );
});
