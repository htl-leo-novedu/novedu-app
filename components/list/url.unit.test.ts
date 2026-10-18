import { describe, expect, it } from "vitest";
import { listHref, paramValue, parseMultiParam } from "@/components/list/url";

const STATES = ["active", "upcoming", "expired"] as const;

describe("paramValue", () => {
  it("reads the first value, trimmed, and an absent param as empty", () => {
    expect(paramValue({ q: "  lists " }, "q")).toBe("lists");
    expect(paramValue({ q: ["a", "b"] }, "q")).toBe("a");
    expect(paramValue({}, "q")).toBe("");
  });
});

describe("parseMultiParam", () => {
  it("splits one comma-separated param and keeps the allowed order", () => {
    expect(parseMultiParam({ status: "expired,active" }, "status", STATES)).toEqual([
      "active",
      "expired",
    ]);
  });

  it("drops unknown values and duplicates, and reads a missing param as none", () => {
    expect(parseMultiParam({ status: "active,nope,active" }, "status", STATES)).toEqual(["active"]);
    expect(parseMultiParam({}, "status", STATES)).toEqual([]);
  });

  it("is first-wins for a repeated key, like every other list param", () => {
    expect(parseMultiParam({ status: ["upcoming", "active"] }, "status", STATES)).toEqual([
      "upcoming",
    ]);
  });
});

describe("listHref", () => {
  it("applies the change, drops the page, keeps sort and size", () => {
    expect(
      listHref("/codes", { q: "x", page: "3", sort: "-note", size: "50" }, { status: "active" }),
    ).toBe("/codes?q=x&sort=-note&size=50&status=active");
  });

  it("removes a param for an empty or undefined value", () => {
    expect(listHref("/codes", { owner: "all", status: "active" }, { status: "" })).toBe(
      "/codes?owner=all",
    );
    expect(listHref("/codes", { owner: "all" }, { owner: undefined })).toBe("/codes");
  });

  it("keeps commas readable", () => {
    expect(listHref("/codes", {}, { module: "tutor,quiz" })).toBe("/codes?module=tutor,quiz");
  });
});
