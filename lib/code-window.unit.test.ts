import { describe, expect, it } from "vitest";
import { windowStatus } from "@/lib/code-window";

const NOW = new Date("2026-10-18T12:00:00Z");
const BEFORE = new Date("2026-10-18T11:00:00Z");
const AFTER = new Date("2026-10-18T13:00:00Z");

describe("windowStatus", () => {
  it("reads a window around now as active, bounds inclusive", () => {
    expect(windowStatus({ validFrom: BEFORE, validUntil: AFTER }, NOW)).toBe("active");
    expect(windowStatus({ validFrom: NOW, validUntil: NOW }, NOW)).toBe("active");
  });

  it("reads a missing bound as open on that side", () => {
    expect(windowStatus({ validFrom: null, validUntil: null }, NOW)).toBe("active");
    expect(windowStatus({ validFrom: null, validUntil: BEFORE }, NOW)).toBe("expired");
    expect(windowStatus({ validFrom: AFTER, validUntil: null }, NOW)).toBe("upcoming");
  });

  it("lets upcoming win over expired for an inverted window", () => {
    expect(windowStatus({ validFrom: AFTER, validUntil: BEFORE }, NOW)).toBe("upcoming");
  });
});
