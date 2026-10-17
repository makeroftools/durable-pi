import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson, sha256Hex } from "../src/hash.js";

// Content addressing has to be byte-for-byte the same everywhere: the SDK derives batch idempotency keys from
// it, and dpi-backend binds a key to the request body with it.
test("sha256Hex matches the FIPS 180-4 vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assert.equal(
    sha256Hex("a".repeat(1_000_000),
    ),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  );
});

// Every length class matters: the padding branch changes at 55/56/63/64 bytes and across block boundaries.
test("sha256Hex agrees with node:crypto on every length and on UTF-8", () => {
  const alphabet = "abc123 \t\n\"\\/\u00e9\u4e2d\u{1f600}";
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % alphabet.length;
  for (let length = 0; length < 300; length++) {
    let text = "";
    for (let i = 0; i < length; i++) text += alphabet[next()];
    assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"), `length ${length}`);
  }
});

test("canonicalJson sorts keys at every depth and matches JSON for orderings", () => {
  const a = { b: 1, a: { d: [3, { z: null, y: true }], c: "x" } };
  const b = { a: { c: "x", d: [3, { y: true, z: null }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}');
  // Undefined fields vanish exactly as JSON.stringify drops them; array holes become null.
  assert.equal(canonicalJson({ a: undefined, b: [undefined, 1] }), '{"b":[null,1]}');
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson("s"), '"s"');
  assert.equal(canonicalJson([1, "a", false]), '[1,"a",false]');
  // Insertion order never changes the hash.
  assert.equal(
    sha256Hex(canonicalJson({ x: 1, y: 2 })),
    sha256Hex(canonicalJson({ y: 2, x: 1 })),
  );
});
