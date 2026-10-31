import { describe, expect, test } from "bun:test";
import { ConfigSchema, withWarnBelowThreshold } from "../src/core/stores.ts";

const config = (overrides: object) => ConfigSchema.parse(overrides);

describe("withWarnBelowThreshold", () => {
  test("leaves a valid pair alone", () => {
    expect(withWarnBelowThreshold(config({ threshold: 90, warnAt: 80 }), "threshold")).toMatchObject({ threshold: 90, warnAt: 80 });
  });

  test("lowering the threshold to or below the warning level moves the warning ten points under it", () => {
    expect(withWarnBelowThreshold(config({ threshold: 80, warnAt: 85 }), "threshold")).toMatchObject({ threshold: 80, warnAt: 70 });
    expect(withWarnBelowThreshold(config({ threshold: 5, warnAt: 85 }), "threshold")).toMatchObject({ threshold: 5, warnAt: 1 });
  });

  test("raising the warning level to or above the threshold moves the threshold one point above it", () => {
    expect(withWarnBelowThreshold(config({ threshold: 95, warnAt: 97 }), "warnAt")).toMatchObject({ threshold: 98, warnAt: 97 });
    expect(withWarnBelowThreshold(config({ threshold: 95, warnAt: 100 }), "warnAt")).toMatchObject({ threshold: 100, warnAt: 99 });
  });
});
