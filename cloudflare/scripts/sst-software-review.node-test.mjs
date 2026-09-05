import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSoftwareRows, latestPublished } from "./sst-software-review.mjs";

test("selects only the matching state's published library, never drafts", () => {
  const valid = { stateId: 14, formId: 10, formTypeId: 1, version: 2026, published: true };
  assert.deepEqual(
    latestPublished(
      [
        valid,
        { ...valid, published: false, version: 2027 },
        { ...valid, stateId: -14, version: 2028 },
      ],
      14,
    ),
    valid,
  );
  assert.throws(() => latestPublished([], 14), /Missing/);
  assert.throws(() => latestPublished([valid, { ...valid, formId: 11 }], 14), /ambiguous/);
});

test("keeps software answers and caveats without mistaking answer codes for tax rates", () => {
  const row = {
    displayColumns: [
      { orderId: 1, tValue: "30050" },
      { orderId: 2, tValue: "Prewritten computer software delivered electronically" },
      { orderId: 3, value: " 1 ", validationTypeId: 13 },
      { orderId: 4, value: "<p>Statute reference</p>", validationTypeId: 9 },
      { orderId: 5, value: " Business use exception ", validationTypeId: 9 },
    ],
  };
  const result = extractSoftwareRows([row, { displayColumns: [{ orderId: 1, tValue: "20120" }] }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].cells[0].answer, "1");
  assert.equal(result[0].cells[2].answer, "Business use exception");
  assert.equal(result[0].rate_ppm, undefined);
  assert.throws(() => extractSoftwareRows({}), /Invalid/);
});
