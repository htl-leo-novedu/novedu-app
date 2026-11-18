import { beforeEach, describe, expect, it, vi } from "vitest";
import { localHourLabel } from "./local-hour";

// The hourly usage labels in the viewer's time zone (docs/dashboard.md, "Time
// model"). Pinned to Europe/Vienna — Node re-reads `process.env.TZ` on assignment,
// which `vi.stubEnv` does (and the config's `unstubEnvs` undoes before every test,
// hence `beforeEach`) — so the clock changes are deterministic on any machine.
// No DB, runs in CI.

beforeEach(() => {
  vi.stubEnv("TZ", "Europe/Vienna");
});

describe("localHourLabel", () => {
  it("shows an ordinary hour as plain local wall-clock time", () => {
    expect(localHourLabel("2026-07-04T12:00:00.000Z")).toBe("14:00"); // CEST
    expect(localHourLabel("2026-11-18T12:00:00.000Z")).toBe("13:00"); // CET
  });

  it("tells the repeated hour apart when the clocks go back", () => {
    // 2026-10-25: 03:00 CEST becomes 02:00 CET, so 02:00 local happens twice.
    expect(localHourLabel("2026-10-24T23:00:00.000Z")).toBe("01:00");
    expect(localHourLabel("2026-10-25T00:00:00.000Z")).toBe("02:00 (UTC+2)");
    expect(localHourLabel("2026-10-25T01:00:00.000Z")).toBe("02:00 (UTC+1)");
    expect(localHourLabel("2026-10-25T02:00:00.000Z")).toBe("03:00");
  });

  it("needs no offset when the clocks go forward (an hour is skipped, none repeated)", () => {
    // 2026-03-29: 02:00 CET becomes 03:00 CEST.
    expect(localHourLabel("2026-03-29T00:00:00.000Z")).toBe("01:00");
    expect(localHourLabel("2026-03-29T01:00:00.000Z")).toBe("03:00");
  });
});
