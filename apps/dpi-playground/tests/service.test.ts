// The hub user unit is generated from a template; a missing placeholder or a wrong port would produce a
// service that silently never starts, so both are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hubPort, hubUnitPlan, renderTemplate } from "../src/service.js";

test("renderTemplate replaces every placeholder and refuses an unknown one", () => {
  assert.equal(renderTemplate("a __APP__ b __NODE__", { APP: "/x", NODE: "/n" }), "a /x b /n");
  assert.throws(() => renderTemplate("__MISSING__", {}), /Unknown service template placeholder __MISSING__/);
});

test("hubPort reads DPI_HUB_PORT, defaults to 4781 and refuses a bad value", () => {
  assert.equal(hubPort({}), "4781");
  assert.equal(hubPort({ DPI_HUB_PORT: "4999" }), "4999");
  for (const bad of ["0", "65536", "port", ""]) assert.throws(() => hubPort({ DPI_HUB_PORT: bad }), /TCP port/);
});

test("the hub user unit serves the built UI, restarts on failure and carries no token", () => {
  const plan = hubUnitPlan("/opt/dpi/apps/dpi-playground", {
    node: "/usr/bin/node",
    home: "/home/op",
    dpiHome: "/home/op/.dpi",
    port: "4799",
  });
  assert.equal(plan.path, "/home/op/.config/systemd/user/dpi-hub.service");
  assert.match(
    plan.content,
    /ExecStart=\/usr\/bin\/node \/opt\/dpi\/apps\/dpi-playground\/node_modules\/tsx\/dist\/cli\.mjs apps\/dpi-playground-hub\/src\/main\.ts/,
  );
  assert.match(plan.content, /^Environment=HOME=\/home\/op$/m);
  assert.match(plan.content, /^Environment=DPI_HOME=\/home\/op\/\.dpi$/m);
  assert.match(plan.content, /^Environment=DPI_HUB_PORT=4799$/m);
  assert.match(plan.content, /^Restart=always$/m);
  assert.match(plan.content, /^StandardOutput=append:\/home\/op\/\.dpi\/hub\.log$/m);
  assert.match(plan.content, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(plan.content, /__[A-Z_]+__/, "no placeholder is left unrendered");
  assert.doesNotMatch(plan.content, /TOKEN|SECRET|PASSWORD/i, "the unit carries no secret");
  assert.deepEqual(plan.enable, ["systemctl", "--user", "enable", "--now", "dpi-hub.service"]);
  assert.deepEqual(plan.logs.slice(0, 4), ["journalctl", "--user", "-u", "dpi-hub.service"]);
  assert.match(plan.linger, /^loginctl enable-linger /);
});
