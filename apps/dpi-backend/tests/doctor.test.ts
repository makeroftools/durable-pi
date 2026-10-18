import { test } from "node:test";
import assert from "node:assert/strict";
import { modelCount, verdict, type Check } from "../src/doctor.js";

const check = (name: string, ok: boolean, critical: boolean): Check => ({ name, ok, critical, detail: "" });

test("verdict fails on a critical failure and ignores a non-critical one", () => {
  assert.deepEqual(verdict([check("a", true, true), check("b", false, false)]), { ok: true, failures: [] });
  assert.deepEqual(verdict([check("a", false, true), check("b", false, false)]), { ok: false, failures: ["a"] });
  assert.deepEqual(verdict([check("a", false, true), check("b", false, true)]), { ok: false, failures: ["a", "b"] });
});

test("modelCount reads only a model array, and treats an empty one as zero", () => {
  assert.equal(modelCount({ models: [{}, {}] }), 2);
  assert.equal(modelCount({ models: [] }), 0);
  assert.equal(modelCount({}), undefined);
  assert.equal(modelCount(null), undefined);
  assert.equal(modelCount({ models: "nope" }), undefined);
});
