// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ContentSummary,
  ErrorList,
  FragmentSummary,
  locationOf,
  WarningList,
} from "./validation-result";

describe("locationOf", () => {
  it("joins file alias and fragment id", () => {
    expect(locationOf({ fileAlias: "general", fragmentId: "socratic_tutor" })).toBe(
      "general / socratic_tutor",
    );
  });

  it("appends the variable with a separator", () => {
    expect(
      locationOf({ fileAlias: "general", fragmentId: "socratic_tutor", variable: "domain" }),
    ).toBe("general / socratic_tutor · domain");
  });

  it("returns just the variable when nothing else is present", () => {
    expect(locationOf({ variable: "domain" })).toBe("domain");
  });

  it("returns null when there is nothing to locate", () => {
    expect(locationOf({})).toBeNull();
  });
});

describe("ErrorList", () => {
  it("renders the count, each code, message, and location", () => {
    render(
      <ErrorList
        errors={[
          {
            code: "MISSING_REQUIRED_VARIABLE",
            message: "Fragment socratic_tutor requires variable domain",
            fileAlias: "general",
            fragmentId: "socratic_tutor",
            variable: "domain",
          },
          { code: "HOST_TEMPLATE_PARSE_ERROR", message: "Host text is not a valid template" },
        ]}
      />,
    );

    expect(screen.getByText("Validation failed (2)")).toBeInTheDocument();
    expect(screen.getByText("MISSING_REQUIRED_VARIABLE")).toBeInTheDocument();
    expect(
      screen.getByText("Fragment socratic_tutor requires variable domain"),
    ).toBeInTheDocument();
    expect(screen.getByText("general / socratic_tutor · domain")).toBeInTheDocument();
    expect(screen.getByText("HOST_TEMPLATE_PARSE_ERROR")).toBeInTheDocument();
  });

  it("renders flattened zod issue detail for schema errors", () => {
    render(
      <ErrorList
        errors={[
          {
            code: "TUTOR_SCHEMA_ERROR",
            message: "Document does not match the expected structure",
            zodIssues: {
              errors: ['Unrecognized key: "nae"'],
              properties: {
                name: { errors: ["Invalid input: expected string, received undefined"] },
              },
            },
          },
        ]}
      />,
    );

    expect(screen.getByText('Unrecognized key: "nae"')).toBeInTheDocument();
    expect(
      screen.getByText("name: Invalid input: expected string, received undefined"),
    ).toBeInTheDocument();
  });
});

describe("FragmentSummary", () => {
  it("renders the fragment file id and each fragment id", () => {
    render(
      <FragmentSummary
        result={{
          ok: true,
          fragmentFileId: "simple-fragments",
          fragmentIds: ["persona", "ground_rules"],
          warnings: [],
        }}
      />,
    );

    expect(screen.getByText("simple-fragments")).toBeInTheDocument();
    expect(screen.getByText("persona")).toBeInTheDocument();
    expect(screen.getByText("ground_rules")).toBeInTheDocument();
  });
});

describe("WarningList", () => {
  it("renders warning code and message", () => {
    render(
      <WarningList
        warnings={[
          {
            code: "UNDECLARED_VARIABLE",
            message: "Variable surprise is not declared",
            fragmentId: "socratic_tutor",
            variable: "surprise",
          },
        ]}
      />,
    );

    expect(screen.getByText("Warnings (1)")).toBeInTheDocument();
    expect(screen.getByText("UNDECLARED_VARIABLE")).toBeInTheDocument();
    expect(screen.getByText("Variable surprise is not declared")).toBeInTheDocument();
  });
});

describe("ContentSummary", () => {
  it("renders the validator's one-line summary verbatim", () => {
    const summary = '2 gaps · 1 "is going to" · 2 "starts" (start)';
    render(<ContentSummary summary={summary} />);

    expect(screen.getByText(summary)).toBeInTheDocument();
  });
});
