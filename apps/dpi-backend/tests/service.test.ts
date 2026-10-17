// The user unit is generated from a template; a missing placeholder or a wrong path would produce a service that
// silently never starts, so both are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, userUnitPlan } from "../src/service.js";

test("renderTemplate replaces every placeholder and refuses an unknown one", () => {
  assert.equal(renderTemplate("a __APP__ b __NODE__", { APP: "/x", NODE: "/n" }), "a /x b /n");
  assert.throws(() => renderTemplate("__MISSING__", {}), /Unknown service template placeholder __MISSING__/);
});

test("the user unit points at this app, restarts on failure and starts at login without sudo", () => {
  const plan = userUnitPlan("/opt/dpi/apps/dpi-backend", {
    node: "/usr/bin/node",
    home: "/home/op",
    dpiHome: "/home/op/.dpi",
  });
  assert.equal(plan.path, "/home/op/.config/systemd/user/dpi-backend.service");
  assert.match(
    plan.content,
    /ExecStart=\/usr\/bin\/node \/opt\/dpi\/apps\/dpi-backend\/node_modules\/tsx\/dist\/cli\.mjs src\/main\.ts/,
  );
  assert.match(plan.content, /^Environment=HOME=\/home\/op$/m);
  assert.match(plan.content, /^Environment=DPI_HOME=\/home\/op\/\.dpi$/m);
  assert.match(plan.content, /^Restart=always$/m);
  assert.match(plan.content, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(plan.content, /__[A-Z_]+__/, "no placeholder is left unrendered");
  assert.deepEqual(plan.enable, ["systemctl", "--user", "enable", "--now", "dpi-backend.service"]);
  assert.deepEqual(plan.logs.slice(0, 4), ["journalctl", "--user", "-u", "dpi-backend.service"]);
  assert.match(plan.linger, /^loginctl enable-linger /);
});
