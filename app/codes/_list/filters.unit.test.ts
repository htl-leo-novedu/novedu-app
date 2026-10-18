import { describe, expect, it } from "vitest";
import {
  appliedCodeFilters,
  clearFiltersHref,
  codeFilterCount,
  codeFilterSummary,
  parseCodeFilters,
} from "./filters";

// The `/codes` filters on the new list engine: the URL parses into the store's
// filter (unknown values drop out) and into the filter panel's starting draft,
// the summary line names the applied filters in a fixed order, and "Clear all"
// keeps the sort and size.

const ME = "user-me";
const OWNERS = [
  { userId: ME, label: "Me Myself" },
  { userId: "user-ada", label: "Ada Lovelace" },
];

describe("parseCodeFilters", () => {
  it("reads every param, keeping only known values in their canonical order", () => {
    const filters = parseCodeFilters(
      { q: "  math ", owner: "all", module: "quiz,bogus,tutor,quiz", status: "expired,soon" },
      ME,
    );
    expect(filters).toEqual({
      q: "math",
      owner: { value: "all", createdBy: undefined },
      modules: ["tutor", "quiz"],
      statuses: ["expired"],
    });
  });

  it("defaults to my own codes with no other filter", () => {
    expect(parseCodeFilters({}, ME)).toEqual({
      q: "",
      owner: { value: "", createdBy: ME },
      modules: [],
      statuses: [],
    });
  });
});

describe("appliedCodeFilters / codeFilterCount", () => {
  const applied = (sp: Record<string, string>) => appliedCodeFilters(parseCodeFilters(sp, ME), ME);

  it("starts the panel's draft from the URL; my own codes are the unset owner", () => {
    expect(applied({})).toEqual({ q: [], owner: [], module: [], status: [] });
    expect(applied({ owner: ME })).toEqual({ q: [], owner: [], module: [], status: [] });
    expect(applied({ q: "frac", owner: "all", module: "quiz,tutor", status: "active" })).toEqual({
      q: ["frac"],
      owner: ["all"],
      module: ["tutor", "quiz"],
      status: ["active"],
    });
  });

  it("counts every applied value, the search term included", () => {
    const count = (sp: Record<string, string>) => codeFilterCount(parseCodeFilters(sp, ME), ME);
    expect(count({ owner: ME })).toBe(0);
    expect(count({ q: "x", owner: "user-ada", module: "tutor,quiz", status: "active" })).toBe(5);
  });
});

describe("codeFilterSummary", () => {
  const summary = (sp: Record<string, string>) =>
    codeFilterSummary(parseCodeFilters(sp, ME), OWNERS, ME);

  it("always names the owner, even the default — my own codes are a filter too", () => {
    expect(summary({})).toEqual([{ label: "Owner", value: "mine" }]);
    expect(summary({ owner: ME })).toEqual([{ label: "Owner", value: "mine" }]);
    expect(summary({ owner: "all" })[0]?.value).toBe("all owners");
    expect(summary({ owner: "user-ada" })[0]?.value).toBe("Ada Lovelace");
    expect(summary({ owner: "user-gone" })[0]?.value).toBe("user-gone");
  });

  it("adds activity, status and search in a fixed order, only when set", () => {
    expect(summary({ q: "frac", status: "expired,active", module: "quiz,tutor" })).toEqual([
      { label: "Owner", value: "mine" },
      { label: "Activity", value: "Tutor, Quiz" },
      { label: "Status", value: "Active, Expired" },
      { label: "Search", value: "“frac”" },
    ]);
  });
});

describe("clearFiltersHref", () => {
  it("drops every filter and the page but keeps the sort and the page size", () => {
    expect(
      clearFiltersHref({
        q: "x",
        owner: "all",
        module: "quiz",
        status: "active",
        sort: "-until",
        size: "50",
        page: "4",
      }),
    ).toBe("/codes?sort=-until&size=50");
  });
});
