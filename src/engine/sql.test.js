import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeSelect, withLimit } from "./sql.js";

test("allows a single SELECT", () => {
  assert.equal(isSafeSelect("SELECT id FROM orders"), true);
});

test("allows WITH ... SELECT", () => {
  assert.equal(
    isSafeSelect("WITH paid AS (SELECT id FROM orders) SELECT COUNT(*) FROM paid"),
    true
  );
});

test("allows REPLACE() in a SELECT", () => {
  assert.equal(isSafeSelect("SELECT REPLACE(desk_name, '_', ' ') FROM customers"), true);
});

test("rejects INSERT, UPDATE, and DELETE", () => {
  assert.equal(isSafeSelect("INSERT INTO orders (id) VALUES (1)"), false);
  assert.equal(isSafeSelect("UPDATE orders SET status_code = 'x'"), false);
  assert.equal(isSafeSelect("DELETE FROM orders"), false);
});

test("rejects a second statement after SELECT", () => {
  assert.equal(isSafeSelect("SELECT id FROM orders; DELETE FROM orders"), false);
  assert.equal(isSafeSelect("SELECT id FROM orders ; INSERT INTO orders (id) VALUES (1)"), false);
});

test("rejects INTO OUTFILE / DUMPFILE", () => {
  assert.equal(isSafeSelect("SELECT * FROM orders INTO OUTFILE '/tmp/x'"), false);
  assert.equal(isSafeSelect("SELECT * FROM orders INTO DUMPFILE '/tmp/x'"), false);
});

test("rejects write verbs hidden in comments", () => {
  assert.equal(isSafeSelect("/*!50000 INSERT INTO orders (id) VALUES (1) */"), false);
  assert.equal(isSafeSelect("SELECT id FROM orders /* ; DELETE FROM orders */"), true);
  assert.equal(isSafeSelect("WITH x AS (SELECT 1) DELETE FROM orders"), false);
});

test("rejects SELECT FOR UPDATE and CALL", () => {
  assert.equal(isSafeSelect("SELECT id FROM orders FOR UPDATE"), false);
  assert.equal(isSafeSelect("CALL wipe_orders()"), false);
  assert.equal(isSafeSelect("SET @a = 1"), false);
});

test("rejects LOAD_FILE", () => {
  assert.equal(isSafeSelect("SELECT LOAD_FILE('/etc/passwd')"), false);
});

test("withLimit does not put LIMIT inside a trailing comment", () => {
  const sql = withLimit("SELECT id FROM orders -- recent");
  assert.match(sql, /\nLIMIT \d+$/);
  assert.equal(isSafeSelect(sql), true);
});
