import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { loadModelRegistry } from "../scripts/lib/models.mjs";

const glm = { MULTIPOLY_GLM_API_KEY: "g" };

function fileWith(obj) {
  const dir = mkdtempSync(join(tmpdir(), "multipoly-reg-"));
  const path = join(dir, "models.json");
  writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj));
  return path;
}

test("registry-file: unset MULTIPOLY_MODELS_FILE loads nothing (no cwd auto-load)", () => {
  const r = loadModelRegistry({ ...glm });
  assert.equal(r.keys.includes("filemodel"), false);
});

test("registry-file: an anthropic entry merges into the registry and configures", () => {
  const path = fileWith({
    models: {
      haiku: {
        transport: "anthropic",
        displayName: "Claude Haiku 4.5",
        model: "claude-haiku-4-5",
        apiKeyEnv: "MY_HAIKU_KEY",
      },
    },
  });
  const c = loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: path, MY_HAIKU_KEY: "sk-x" });
  assert.ok(c.modelKeys.includes("haiku"));
  assert.equal(c.models.haiku.transport, "anthropic");
  assert.equal(c.models.haiku.configured, true);
  assert.equal(c.models.haiku.model, "claude-haiku-4-5");
  assert.equal(c.models.haiku.baseUrl, "https://api.anthropic.com");
  assert.equal(c.models.haiku.displayName, "Claude Haiku 4.5");
  // Builtins remain.
  assert.ok(c.modelKeys.includes("glm"));
});

test("registry-file: a cli entry declares kind/binary/auth/cwd and can be enabled", () => {
  const path = fileWith({
    models: {
      mygem: {
        transport: "cli",
        cliKind: "gemini",
        displayName: "Gemini",
        model: "gemini-3-pro",
        binary: "/opt/gemini",
        authTokenEnv: "GEMINI_API_KEY",
        cwd: "temp",
        enabled: true,
      },
    },
  });
  const c = loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: path });
  assert.equal(c.models.mygem.transport, "cli");
  assert.equal(c.models.mygem.cliKind, "gemini");
  assert.equal(c.models.mygem.binary, "/opt/gemini");
  assert.equal(c.models.mygem.model, "gemini-3-pro");
  assert.equal(c.models.mygem.authTokenEnv, "GEMINI_API_KEY");
  assert.equal(c.models.mygem.cwdMode, "temp");
  assert.equal(c.models.mygem.configured, true);
});

test("registry-file: env vars override file-declared fields", () => {
  const path = fileWith({
    models: {
      mygem: { transport: "cli", cliKind: "gemini", model: "gemini-3-pro", enabled: true },
    },
  });
  const c = loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: path, MULTIPOLY_MYGEM_MODEL: "gemini-3-ultra" });
  assert.equal(c.models.mygem.model, "gemini-3-ultra");
});

test("registry-file: a literal apiKey field is rejected (secrets belong in env)", () => {
  const path = fileWith({
    models: { haiku: { transport: "anthropic", model: "m", apiKey: "sk-ant-leak" } },
  });
  assert.throws(
    () => loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: path }),
    (e) => e.code === "CONFIG",
  );
});

test("registry-file: a value that scans as a secret is rejected", () => {
  const path = fileWith({
    models: { haiku: { transport: "anthropic", model: "AKIAIOSFODNN7EXAMPLE", apiKeyEnv: "K" } },
  });
  assert.throws(
    () => loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: path }),
    (e) => e.code === "CONFIG" && /secret/i.test(e.message),
  );
});

test("registry-file: an unknown field is rejected", () => {
  const path = fileWith({
    models: { haiku: { transport: "anthropic", model: "m", apiKeyEnv: "K", argv: ["--rm", "-rf"] } },
  });
  assert.throws(
    () => loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: path }),
    (e) => e.code === "CONFIG",
  );
});

test("registry-file: collision with a builtin / reserved word is rejected", () => {
  for (const bad of ["glm", "council", "harness"]) {
    const path = fileWith({ models: { [bad]: { transport: "anthropic", model: "m", apiKeyEnv: "K" } } });
    assert.throws(
      () => loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: path }),
      (e) => e.code === "CONFIG",
      `expected ${bad} rejected`,
    );
  }
});

test("registry-file: collision with a MULTIPOLY_MODELS key is rejected", () => {
  const path = fileWith({ models: { dupe: { transport: "anthropic", model: "m", apiKeyEnv: "K" } } });
  assert.throws(
    () =>
      loadConfig({
        ...glm,
        MULTIPOLY_MODELS: "dupe",
        MULTIPOLY_DUPE_API_KEY: "k",
        MULTIPOLY_DUPE_BASE_URL: "https://d/v1",
        MULTIPOLY_DUPE_MODEL: "m",
        MULTIPOLY_MODELS_FILE: path,
      }),
    (e) => e.code === "CONFIG",
  );
});

test("registry-file: invalid transport / cliKind / authTokenEnv NAME rejected", () => {
  const badTransport = fileWith({ models: { x: { transport: "smoke-signal", model: "m" } } });
  assert.throws(() => loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: badTransport }), (e) => e.code === "CONFIG");

  const badKind = fileWith({ models: { x: { transport: "cli", cliKind: "emacs", enabled: true } } });
  assert.throws(() => loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: badKind }), (e) => e.code === "CONFIG");

  const badAuth = fileWith({
    models: { x: { transport: "cli", cliKind: "claude", authTokenEnv: "not a name", enabled: true } },
  });
  assert.throws(() => loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: badAuth }), (e) => e.code === "CONFIG");
});

test("registry-file: malformed JSON / missing file is a CONFIG error", () => {
  const bad = fileWith("{ not json");
  assert.throws(() => loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: bad }), (e) => e.code === "CONFIG");
  assert.throws(
    () => loadConfig({ ...glm, MULTIPOLY_MODELS_FILE: "/no/such/path/models.json" }),
    (e) => e.code === "CONFIG",
  );
});
