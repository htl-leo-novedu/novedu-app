import { describe, expect, it } from "vitest";
import { clearFiltersHref, codeFilterChips, parseCodeFilters } from "./filters";

// The `/codes` filters on the new list engine: the URL parses into the store's
// filter (unknown values drop out), each active value becomes one removable chip
// whose link removes exactly that value, and "Clear all" keeps the sort and size.

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

describe("codeFilterChips", () => {
  const chips = (sp: Record<string, string>) =>
    codeFilterChips(sp, parseCodeFilters(sp, ME), OWNERS, ME);

  it("has no chip for the default owner, me — named or implied", () => {
    expect(chips({})).toEqual([]);
    expect(chips({ owner: ME })).toEqual([]);
  });

  it("names the owner: all, a known teacher, or the raw id of an unknown one", () => {
    expect(chips({ owner: "all" })).toEqual([{ label: "All owners", removeHref: "/codes" }]);
    expect(chips({ owner: "user-ada" })[0]?.label).toBe("Owner: Ada Lovelace");
    expect(chips({ owner: "user-gone" })[0]?.label).toBe("Owner: user-gone");
  });

  it("gives each activity and status value its own chip that removes only that value", () => {
    const sp = { module: "tutor,quiz", status: "active", sort: "note", page: "2" };
    expect(chips(sp)).toEqual([
      { label: "Tutor", removeHref: "/codes?status=active&sort=note&module=quiz" },
      { label: "Quiz", removeHref: "/codes?status=active&sort=note&module=tutor" },
      { label: "Active", removeHref: "/codes?module=tutor,quiz&sort=note" },
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
