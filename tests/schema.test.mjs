import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReview, validateCouncilReview } from "../scripts/lib/schema.mjs";

const valid = {
  schema_version: "1",
  findings: [
    { severity: "high", path: "src/a.ts", line: 10, message: "nope", suggestion: "fix it" },
    { severity: "nit", path: "src/b.ts", message: "small thing" },
  ],
  summary_md: "## summary\n- one\n- two",
};

test("schema: valid doc", () => {
  assert.deepEqual(validateReview(valid), { valid: true });
});

test("schema: missing schema_version", () => {
  const { schema_version, ...rest } = valid;
  const r = validateReview(rest);
  assert.equal(r.valid, false);
});

test("schema: wrong schema_version", () => {
  const r = validateReview({ ...valid, schema_version: "2" });
  assert.equal(r.valid, false);
});

test("schema: findings not array", () => {
  const r = validateReview({ ...valid, findings: "nope" });
  assert.equal(r.valid, false);
});

test("schema: bad severity", () => {
  const r = validateReview({
    ...valid,
    findings: [{ severity: "critical", path: "a", message: "x" }],
  });
  assert.equal(r.valid, false);
});

test("schema: empty path rejected", () => {
  const r = validateReview({
    ...valid,
    findings: [{ severity: "high", path: "", message: "x" }],
  });
  assert.equal(r.valid, false);
});

test("schema: non-integer line rejected", () => {
  const r = validateReview({
    ...valid,
    findings: [{ severity: "high", path: "a", line: 1.5, message: "x" }],
  });
  assert.equal(r.valid, false);
});

test("schema: suggestion wrong type", () => {
  const r = validateReview({
    ...valid,
    findings: [{ severity: "high", path: "a", message: "x", suggestion: 123 }],
  });
  assert.equal(r.valid, false);
});

test("schema: empty findings array is valid", () => {
  assert.deepEqual(
    validateReview({ schema_version: "1", findings: [], summary_md: "nothing to report" }),
    { valid: true },
  );
});

test("schema: null line/end_line/suggestion accepted (strict-mode nullable)", () => {
  const r = validateReview({
    schema_version: "1",
    findings: [
      { severity: "high", path: "a.ts", message: "x", line: null, end_line: null, suggestion: null },
    ],
    summary_md: "s",
  });
  assert.deepEqual(r, { valid: true });
});

test("schema: end_line < line rejected", () => {
  const r = validateReview({
    schema_version: "1",
    findings: [{ severity: "high", path: "a.ts", message: "x", line: 50, end_line: 10 }],
    summary_md: "s",
  });
  assert.equal(r.valid, false);
});

test("schema: end_line without line rejected (impossible range)", () => {
  const r = validateReview({
    schema_version: "1",
    findings: [
      { severity: "high", path: "a.ts", message: "x", line: null, end_line: 10 },
    ],
    summary_md: "s",
  });
  assert.equal(r.valid, false);
  assert.match(r.reason, /end_line requires line/);
});

test("schema: council review requires synthesizer and at least two models", () => {
  assert.deepEqual(
    validateCouncilReview({
      schema_version: "1",
      synthesizer: "qwen",
      models: ["glm", "qwen"],
      findings: [],
      summary_md: "ok",
    }),
    { valid: true },
  );

  const tooFew = validateCouncilReview({
    schema_version: "1",
    synthesizer: "qwen",
    models: ["glm"],
    findings: [],
    summary_md: "ok",
  });
  assert.equal(tooFew.valid, false);
  assert.match(tooFew.reason, /at least two/);
});
