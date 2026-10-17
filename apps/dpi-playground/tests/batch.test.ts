// The batch dialog's convergence rests on two pure rules: a directory line normalises to one path, and each
// path keeps the session name it was first given. Names are part of the spec the idempotency key hashes, so a
// retry that reorders or narrows the list must reproduce the same names.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignNames,
  basename,
  batchSpec,
  normalizeDir,
  parseDirs,
} from "../apps/dpi-playground-fe/src/client/batch.js";

test("normalizeDir trims, drops trailing slashes, keeps the root", () => {
  assert.equal(normalizeDir("  /home/me/project/  "), "/home/me/project");
  assert.equal(normalizeDir("/home/me/project"), "/home/me/project");
  assert.equal(normalizeDir("/"), "/");
  assert.equal(normalizeDir("///"), "/");
  assert.equal(normalizeDir("   "), "");
});

test("parseDirs drops blank lines and flags repeats, in order", () => {
  assert.deepEqual(parseDirs("/a\n\n  /b/ \n/a\n"), [
    { path: "/a", duplicate: false },
    { path: "/b", duplicate: false },
    { path: "/a", duplicate: true },
  ]);
});

test("basename is the last segment", () => {
  assert.equal(basename("/home/me/project-alpha"), "project-alpha");
  assert.equal(basename("/home/me/project-alpha/"), "project-alpha");
  assert.equal(basename("/"), "/");
});

test("assignNames de-duplicates in list order with (2), (3)…", () => {
  const names = assignNames(["/w/api", "/w/web", "/x/api"], new Map());
  assert.equal(names.get("/w/api"), "api");
  assert.equal(names.get("/w/web"), "web");
  assert.equal(names.get("/x/api"), "api (2)");
});

test("a retry keeps frozen names however the list is narrowed or reordered", () => {
  const frozen = new Map<string, string>();
  assignNames(["/w/api", "/w/web", "/x/api"], frozen);
  // The first directory launched; the operator retries the remaining two in a different order.
  assignNames(["/x/api", "/w/web"], frozen);
  assert.equal(frozen.get("/w/api"), "api");
  assert.equal(frozen.get("/w/web"), "web");
  assert.equal(frozen.get("/x/api"), "api (2)", "the collision keeps the name it was first given");
});

test("batchSpec carries the brief and thinking only when set", () => {
  const model = { provider: "faux", modelId: "echo" };
  assert.deepEqual(batchSpec("api", "/w/api", model, "", undefined), {
    name: "api",
    cwd: "/w/api",
    model,
  });
  assert.deepEqual(batchSpec("api", "/w/api", model, "go", "low"), {
    name: "api",
    cwd: "/w/api",
    model,
    prompt: "go",
    thinkingLevel: "low",
  });
});
