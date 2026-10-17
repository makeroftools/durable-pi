import type { RequestHandler } from "express";
import { canonicalJson, sha256Hex } from "../../dpi-sdk/src/hash.js";
import type { Store } from "./store.js";

/**
 * Replays the stored response for a repeated `Idempotency-Key` on create routes, and records the response of the
 * first one. The key is bound to the body it was first used with (canonically hashed, so a proxy or client that
 * re-serializes the same value still matches), so a client can never be handed another request's result.
 */
export function idempotent(store: Store): RequestHandler {
  return (req, res, next) => {
    const key = req.get("idempotency-key");
    if (!key) return next();
    if (key.length > 128) return void res.status(400).json({ error: { code: "invalid", message: "Idempotency-Key too long" } });
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    const bodyHash = sha256Hex(canonicalJson(req.body ?? {}));
    const stored = store.replay(key, route, bodyHash);
    if (stored) return void res.status(stored.status).set("Idempotent-Replay", "true").json(stored.body);
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 400) store.remember(key, route, res.statusCode, body, bodyHash);
      return json(body);
    };
    next();
  };
}
