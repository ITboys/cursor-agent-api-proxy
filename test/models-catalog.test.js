import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_MODELS,
  isKnownModel,
  isModelAllowed,
} from "../dist/models/catalog.js";
import { extractModel } from "../dist/adapter/openai-to-cli.js";

describe("models catalog", () => {
  it("exports a non-empty unique known model list including auto", () => {
    assert.ok(KNOWN_MODELS.includes("auto"));
    assert.ok(KNOWN_MODELS.includes("opus-4.6"));
    assert.ok(KNOWN_MODELS.includes("sonnet-4.5"));
    assert.ok(KNOWN_MODELS.includes("composer-1.5"));
    assert.equal(new Set(KNOWN_MODELS).size, KNOWN_MODELS.length);
  });

  it("isKnownModel matches catalog entries only", () => {
    assert.equal(isKnownModel("opus-4.6"), true);
    assert.equal(isKnownModel("not-a-real-model"), false);
  });

  it("extractModel strips cursor/ and cursor- prefixes against unified catalog", () => {
    assert.equal(extractModel("cursor/opus-4.6"), "opus-4.6");
    assert.equal(extractModel("cursor-opus-4.6"), "opus-4.6");
    assert.equal(extractModel("opus-4.6-thinking"), "opus-4.6-thinking");
  });

  it("extractModel maps unknown ids to auto (no silent pass-through of garbage)", () => {
    assert.equal(extractModel("totally-unknown-xyz"), "auto");
    assert.equal(extractModel("cursor/totally-unknown-xyz"), "auto");
    assert.equal(extractModel("cursor-totally-unknown-xyz"), "auto");
  });
});

describe("isModelAllowed", () => {
  it("allows any model when account has no allowlist", () => {
    assert.equal(isModelAllowed(undefined, "opus-4.6"), true);
    assert.equal(isModelAllowed([], "opus-4.6"), true);
  });

  it("enforces allowlist when configured", () => {
    assert.equal(isModelAllowed(["auto", "sonnet-4.5"], "sonnet-4.5"), true);
    assert.equal(isModelAllowed(["auto", "sonnet-4.5"], "opus-4.6"), false);
    assert.equal(isModelAllowed(["sonnet-4.5"], "auto"), false);
  });
});
