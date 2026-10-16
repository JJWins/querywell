import assert from "node:assert/strict";
import { test } from "node:test";
import { grantsAreReadOnly } from "./readonly.js";

test("accepts SELECT and USAGE grants", () => {
  assert.equal(
    grantsAreReadOnly([
      "GRANT USAGE ON *.* TO `nlq_saas_ro`@`localhost`",
      "GRANT SELECT ON `nlq_proof`.* TO `nlq_saas_ro`@`localhost`",
    ]),
    true
  );
});

test("rejects INSERT and ALL", () => {
  assert.equal(
    grantsAreReadOnly(["GRANT SELECT, INSERT ON `nlq_proof`.* TO `u`@`localhost`"]),
    false
  );
  assert.equal(
    grantsAreReadOnly(["GRANT ALL PRIVILEGES ON `nlq_proof`.* TO `u`@`localhost`"]),
    false
  );
});

test("rejects GRANT OPTION after ON", () => {
  assert.equal(
    grantsAreReadOnly(["GRANT SELECT ON `nlq_proof`.* TO `u`@`localhost` WITH GRANT OPTION"]),
    false
  );
});

test("rejects role grants that do not name privileges", () => {
  assert.equal(grantsAreReadOnly(["GRANT `writer` TO `u`@`localhost`"]), false);
  assert.equal(grantsAreReadOnly([]), false);
});
