import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { IdleTimeout } from "../dist/subprocess/idle-timeout.js";

describe("IdleTimeout", () => {
  it("fires after idleMs with no activity", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let fired = 0;
      const t = new IdleTimeout(1000, () => {
        fired += 1;
      });
      t.touch();
      assert.equal(t.armed, true);
      mock.timers.tick(999);
      assert.equal(fired, 0);
      mock.timers.tick(1);
      assert.equal(fired, 1);
      assert.equal(t.armed, false);
    } finally {
      mock.timers.reset();
    }
  });

  it("renews on touch so prior deadline does not fire", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let fired = 0;
      const t = new IdleTimeout(1000, () => {
        fired += 1;
      });
      t.touch();
      mock.timers.tick(800);
      t.touch(); // renew
      mock.timers.tick(800); // would have fired without renew
      assert.equal(fired, 0);
      mock.timers.tick(200);
      assert.equal(fired, 1);
    } finally {
      mock.timers.reset();
    }
  });

  it("clear prevents firing", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let fired = 0;
      const t = new IdleTimeout(1000, () => {
        fired += 1;
      });
      t.touch();
      t.clear();
      assert.equal(t.armed, false);
      mock.timers.tick(5000);
      assert.equal(fired, 0);
    } finally {
      mock.timers.reset();
    }
  });
});
