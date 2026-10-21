import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveResponseModel } from "../dist/adapter/response-model.js";

describe("resolveResponseModel", () => {
  it("keeps request model even when CLI reports display name", () => {
    assert.equal(resolveResponseModel("opus-4.6", "Auto"), "opus-4.6");
    assert.equal(resolveResponseModel("auto", "Auto"), "auto");
    assert.equal(resolveResponseModel("sonnet-4.5", "Claude Sonnet 4.5"), "sonnet-4.5");
  });

  it("falls back to request model when CLI omits model", () => {
    assert.equal(resolveResponseModel("composer-1.5", undefined), "composer-1.5");
    assert.equal(resolveResponseModel("gpt-5.2", ""), "gpt-5.2");
  });
});
