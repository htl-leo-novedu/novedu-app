import { describe, expect, it } from "vitest";
import {
  boardCallsFromAgui,
  boardCallsFromStored,
  boardPillLabels,
  isAppliedResult,
} from "./calls";
import { changeStatus, describeBoard } from "./describe";
import { type BoardElementSkeleton, finish, layout, MARK, markedIds, wrap } from "./layout";
import { apply, type BoardState, emptyBoard, LIMITS, replay, summary } from "./model";

// The hand-written boards of the drawings spike (one per board kind and the
// UML / flowchart / nested-group cases): each must apply without errors.
const CASES: Record<string, { steps: Record<string, unknown>[] }> = {
  sequence: {
    steps: [
      { op: "board", id: "dhcp", title: "DHCP: DORA", kind: "sequence" },
      { op: "box", id: "laptop", text: "Laptop (no IP yet)", color: "blue" },
      { op: "box", id: "server", text: "DHCP server", color: "yellow" },
      { op: "arrow", id: "discover", from: "laptop", to: "server", text: "1 Discover (broadcast)" },
      { op: "arrow", id: "offer", from: "server", to: "laptop", text: "2 Offer: 10.0.0.23" },
      { op: "arrow", id: "request", from: "laptop", to: "server", text: "3 Request 10.0.0.23" },
      { op: "arrow", id: "ack", from: "server", to: "laptop", text: "4 ACK + lease 8 h" },
      { op: "arrow", id: "configure", from: "laptop", to: "laptop", text: "sets IP, gateway, DNS" },
      { op: "highlight", ids: ["offer"] },
    ],
  },
  bits: {
    steps: [
      { op: "board", id: "ipv4", title: "IPv4 header", kind: "bits" },
      { op: "box", id: "version", text: "Version", bits: 4, color: "blue" },
      { op: "box", id: "ihl", text: "IHL", bits: 4, color: "blue" },
      { op: "box", id: "dscp", text: "DSCP", bits: 6 },
      { op: "box", id: "ecn", text: "ECN", bits: 2 },
      { op: "box", id: "len", text: "Total length", bits: 16 },
      { op: "box", id: "ident", text: "Identification", bits: 16, color: "green" },
      { op: "box", id: "flags", text: "Flags", bits: 3, color: "green" },
      { op: "box", id: "frag", text: "Fragment offset", bits: 13, color: "green" },
      { op: "box", id: "ttl", text: "TTL", bits: 8, color: "yellow" },
      { op: "box", id: "proto", text: "Protocol", bits: 8 },
      { op: "box", id: "csum", text: "Header checksum", bits: 16 },
      { op: "box", id: "src", text: "Source address", bits: 32, color: "gray" },
      { op: "box", id: "dst", text: "Destination address", bits: 32, color: "gray" },
      { op: "box", id: "opts", text: "Options" },
      { op: "highlight", ids: ["ttl"] },
    ],
  },
  zip: {
    steps: [
      { op: "board", id: "zip", title: "ZIP local file header", kind: "bits" },
      { op: "box", id: "sig", text: "Signature PK\\3\\4", bits: 32, color: "gray" },
      { op: "box", id: "ver", text: "Version", bits: 16 },
      { op: "box", id: "nlen", text: "Name length n", bits: 16, color: "yellow" },
      { op: "box", id: "name", text: "File name (n bytes)", color: "yellow" },
      { op: "arrow", from: "nlen", to: "name", text: "how long" },
    ],
  },
  vnet: {
    steps: [
      { op: "board", id: "azure", title: "Azure: web app in a VNet" },
      { op: "box", id: "users", text: "Users (Internet)", row: 0, col: 1, shape: "ellipse" },
      { op: "box", id: "gateway", text: "Application Gateway", row: 1, col: 1, color: "blue" },
      { op: "group", id: "vnet", text: "VNet 10.0.0.0/16", color: "blue" },
      { op: "group", id: "web-subnet", text: "web subnet", in: "vnet", color: "green" },
      { op: "group", id: "db-subnet", text: "db subnet", in: "vnet", color: "yellow" },
      { op: "box", id: "web", text: "Web server", row: 2, col: 0, in: "web-subnet" },
      {
        op: "box",
        id: "db",
        text: "PostgreSQL",
        row: 2,
        col: 2,
        in: "db-subnet",
        shape: "ellipse",
      },
      { op: "arrow", from: "users", to: "gateway", text: "HTTPS" },
      { op: "arrow", from: "gateway", to: "web", text: "HTTP" },
      { op: "arrow", from: "web", to: "db", text: "SQL 5432" },
      { op: "highlight", ids: ["db-subnet"] },
    ],
  },
  flowchart: {
    steps: [
      { op: "board", id: "loop", title: "while (i < 3)" },
      { op: "box", id: "start", text: "Start", row: 0, col: 1, shape: "ellipse", color: "gray" },
      { op: "box", id: "cond", text: "i < 3 ?", row: 1, col: 1, shape: "diamond", color: "yellow" },
      { op: "box", id: "print", text: "print(i); i++", row: 2, col: 1, color: "green" },
      { op: "box", id: "end", text: "End", row: 1, col: 2, shape: "ellipse", color: "gray" },
      { op: "arrow", from: "start", to: "cond" },
      { op: "arrow", from: "cond", to: "print", text: "yes" },
      { op: "arrow", from: "cond", to: "end", text: "no" },
      { op: "arrow", from: "print", to: "cond", text: "again" },
    ],
  },
  uml: {
    steps: [
      { op: "board", id: "inh", title: "Inheritance: is-a" },
      { op: "box", id: "vehicle", text: "Vehicle", row: 0, col: 1, color: "blue" },
      { op: "note", on: "vehicle", text: "brand: String" },
      { op: "note", on: "vehicle", text: "drive()" },
      { op: "box", id: "car", text: "Car", row: 1, col: 0 },
      { op: "box", id: "truck", text: "Truck", row: 1, col: 2 },
      { op: "arrow", from: "car", to: "vehicle", style: "inherits" },
      { op: "arrow", from: "truck", to: "vehicle", style: "inherits" },
      { op: "board", id: "comp", title: "Composition: has-a" },
      { op: "box", id: "car2", text: "Car", row: 0, col: 0, color: "blue" },
      { op: "box", id: "engine", text: "Engine", row: 1, col: 0 },
      { op: "arrow", from: "car2", to: "engine", style: "has", text: "1" },
    ],
  },
};

/** Applies a call that must succeed and returns the new state. */
function ok(state: BoardState, input: unknown): BoardState {
  const r = apply(state, input);
  expect(r.errors).toBeUndefined();
  return r.state as BoardState;
}

const byId = (elements: BoardElementSkeleton[], id: string) => {
  const e = elements.find((x) => x.id === id);
  if (!e) throw new Error(`no element ${id}`);
  return e;
};

describe("apply: the spike's boards", () => {
  for (const [name, input] of Object.entries(CASES)) {
    it(`draws the ${name} board without errors and lays it out`, () => {
      const s = ok(emptyBoard(), input);
      expect(summary(s)).toMatch(/^board /);
      expect(layout(s).length).toBeGreaterThan(0);
    });
  }

  it("summarises boxes with their positions, groups with members, and styled arrows", () => {
    const s = ok(emptyBoard(), CASES.vnet);
    expect(summary(s)).toBe(
      [
        "board azure (grid): users r0c1, gateway r1c1, web r2c0, db r2c2",
        "  groups: vnet{web-subnet db-subnet}, web-subnet{web}, db-subnet{db}",
        "  arrows: users-gateway, gateway-web, web-db",
      ].join("\n"),
    );
    expect(summary(ok(emptyBoard(), CASES.uml))).toContain("arrows: car-vehicle [inherits]");
  });

  it("never changes the input state", () => {
    const s = ok(emptyBoard(), CASES.sequence);
    const before = summary(s);
    apply(s, { steps: [{ op: "remove", ids: ["laptop"] }] });
    apply(s, { steps: [{ op: "box", id: "x" }] });
    expect(summary(s)).toBe(before);
  });
});

describe("apply: errors reject the whole call", () => {
  it("rejects a missing or empty steps array", () => {
    expect(apply(emptyBoard(), {}).errors).toEqual(['"steps" must be a non-empty array of steps']);
    expect(apply(emptyBoard(), { steps: [] }).errors).toHaveLength(1);
    expect(apply(emptyBoard(), null).errors).toHaveLength(1);
  });

  it("applies nothing of a call with one bad step", () => {
    const r = apply(emptyBoard(), {
      steps: [
        { op: "board", id: "b", title: "B" },
        { op: "box", id: "a", text: "A", row: 0, col: 0 },
        { op: "box", id: "c", text: "C", row: 9, col: 0 },
      ],
    });
    expect(r.state).toBeUndefined();
    expect(r.errors).toEqual([
      'steps[2] (box "c"): "row" must be a whole number from 0 to 4 (got 9)',
    ]);
  });

  it("explains unknown ops, bad ids, reused ids and taken cells", () => {
    const s = ok(emptyBoard(), {
      steps: [
        { op: "board", id: "b", title: "B" },
        { op: "box", id: "a", text: "A", row: 0, col: 0 },
      ],
    });
    expect(apply(s, { steps: [{ op: "circle" }] }).errors?.[0]).toMatch(/unknown op "circle"/);
    expect(
      apply(s, { steps: [{ op: "box", id: "1x", text: "X", row: 1, col: 0 }] }).errors?.[0],
    ).toMatch(/"id" must be lowercase/);
    expect(
      apply(s, { steps: [{ op: "box", id: "a", text: "X", row: 1, col: 0 }] }).errors?.[0],
    ).toMatch(/id "a" is already used/);
    expect(
      apply(s, { steps: [{ op: "box", id: "z", text: "Z", row: 0, col: 0 }] }).errors?.[0],
    ).toMatch(/already taken by "a"/);
  });

  it("never reuses an id, not even after remove", () => {
    let s = ok(emptyBoard(), CASES.sequence);
    s = ok(s, { steps: [{ op: "remove", ids: ["server"] }] });
    expect(apply(s, { steps: [{ op: "box", id: "server", text: "S" }] }).errors?.[0]).toMatch(
      /already used/,
    );
  });

  it("asks for a board first and names existing boxes on a bad reference", () => {
    expect(apply(emptyBoard(), { steps: [{ op: "box", id: "a", text: "A" }] }).errors).toEqual([
      'steps[0] (box "a"): no board yet: start with {"op":"board"}',
    ]);
    const s = ok(emptyBoard(), CASES.sequence);
    expect(apply(s, { steps: [{ op: "arrow", from: "laptop", to: "nope" }] }).errors?.[0]).toMatch(
      /"to" refers to "nope", which is not a box on the board\. Existing boxes: laptop, server/,
    );
  });

  it("keeps later steps quiet when an earlier step of the same id failed", () => {
    const r = apply(emptyBoard(), {
      steps: [
        { op: "board", id: "b", title: "B" },
        { op: "box", id: "a", text: "", row: 0, col: 0 },
        { op: "arrow", from: "a", to: "a" },
      ],
    });
    expect(r.errors).toEqual(['steps[1] (box "a"): "text" must be a non-empty string']);
  });

  it("rejects a group frame that would enclose a non-member box", () => {
    const s = ok(emptyBoard(), CASES.vnet);
    expect(
      apply(s, { steps: [{ op: "box", id: "intruder", text: "X", row: 2, col: 1 }] }).errors?.[0],
    ).toMatch(/group "vnet" spans rows 2–2, cols 0–2 and would enclose box "intruder"/);
  });

  it("enforces the limits: boards, text length, elements", () => {
    let s = emptyBoard();
    for (const id of ["a", "b", "c"]) s = ok(s, { steps: [{ op: "board", id, title: id }] });
    expect(apply(s, { steps: [{ op: "board", id: "d", title: "d" }] }).errors?.[0]).toMatch(
      /at most 3 boards/,
    );
    expect(
      apply(emptyBoard(), {
        steps: [{ op: "board", id: "a", title: "x".repeat(LIMITS.title + 1) }],
      }).errors?.[0],
    ).toMatch(/keep it to 70/);
    const fields = Array.from({ length: LIMITS.elements }, (_, i) => ({
      op: "box",
      id: `f${i}`,
      text: "F",
      bits: 8,
    }));
    const r = apply(emptyBoard(), {
      steps: [{ op: "board", id: "seq", title: "S", kind: "bits" }, ...fields],
    });
    expect(r.errors?.at(-1)).toMatch(/more than 40 elements/);
  });

  it.each([
    [
      "sequence participants",
      [
        { op: "board", id: "s", title: "S", kind: "sequence" },
        ...Array.from({ length: LIMITS.actors + 1 }, (_, i) => ({
          op: "box",
          id: `p${i}`,
          text: "P",
        })),
      ],
      /at most 6 boxes \(participants\)/,
    ],
    [
      "notes per box",
      [
        { op: "board", id: "g", title: "G" },
        { op: "box", id: "b", text: "B", row: 0, col: 0 },
        ...Array.from({ length: LIMITS.notesPerBox + 1 }, () => ({
          op: "note",
          on: "b",
          text: "n",
        })),
      ],
      /already has 3 notes/,
    ],
    [
      "group depth",
      [
        { op: "board", id: "g", title: "G" },
        { op: "group", id: "g1", text: "1" },
        { op: "group", id: "g2", text: "2", in: "g1" },
        { op: "group", id: "g3", text: "3", in: "g2" },
        { op: "group", id: "g4", text: "4", in: "g3" },
      ],
      /groups nest at most 3 deep/,
    ],
    [
      "grid row bounds",
      [
        { op: "board", id: "g", title: "G" },
        { op: "box", id: "b", text: "B", row: LIMITS.rows, col: 0 },
      ],
      /row/,
    ],
    [
      "grid col bounds",
      [
        { op: "board", id: "g", title: "G" },
        { op: "box", id: "b", text: "B", row: 0, col: LIMITS.cols },
      ],
      /col/,
    ],
  ])("enforces the %s limit", (_name, steps, message) => {
    const r = apply(emptyBoard(), { steps });
    expect(r.state).toBeUndefined();
    expect(r.errors?.join("\n")).toMatch(message);
  });

  it("only changes what a part allows", () => {
    const s = ok(emptyBoard(), CASES.vnet);
    expect(apply(s, { steps: [{ op: "change", id: "web", row: 3 }] }).errors?.[0]).toMatch(
      /can only change text, color, in of a box \(got row\); to move something, remove it/,
    );
    expect(
      apply(s, { steps: [{ op: "change", id: "users-gateway", color: "red" }] }).errors?.[0],
    ).toMatch(/can only change text, style of a arrow/);
  });
});

describe("apply: forgiving input", () => {
  it("treats ids case-insensitively and null as not given", () => {
    const s = ok(emptyBoard(), {
      steps: [
        { op: "board", id: "B", title: "B", kind: null },
        { op: "box", id: "Web", text: "Web", row: 0, col: 0, color: null },
        { op: "ellipse", id: "user", text: "User", row: 0, col: 1 },
        { op: "arrow", from: "USER", to: "web" },
      ],
    });
    expect([...s.boxes.keys()]).toEqual(["web", "user"]);
    expect(s.boxes.get("user")?.shape).toBe("ellipse");
    expect([...s.arrows.keys()]).toEqual(["user-web"]);
  });

  it("warns, but applies, on a highlight or remove of an unknown id", () => {
    const s = ok(emptyBoard(), CASES.sequence);
    const r = apply(s, { steps: [{ op: "highlight", ids: ["ack", "ghost"] }] });
    expect(r.errors).toBeUndefined();
    expect(r.warnings).toEqual(['steps[0] (highlight): ignored "ghost"; not on the board']);
    expect(r.state?.highlight).toEqual(["ack"]);
  });

  it("removes a box with its arrows, and a group's frame only", () => {
    let s = ok(emptyBoard(), CASES.vnet);
    s = ok(s, { steps: [{ op: "remove", ids: ["web", "web-subnet"] }] });
    expect(s.boxes.has("web")).toBe(false);
    expect(s.arrows.has("gateway-web")).toBe(false);
    expect(s.arrows.has("web-db")).toBe(false);
    expect(s.groups.has("web-subnet")).toBe(false);
    expect(s.boxes.get("db")?.in).toBe("db-subnet");
  });

  it("a highlight lasts until the next call", () => {
    let s = ok(emptyBoard(), CASES.sequence);
    expect(s.highlight).toEqual(["offer"]);
    s = ok(s, { steps: [{ op: "change", id: "ack", text: "4 ACK" }] });
    expect(s.highlight).toEqual([]);
    expect(s.fresh).toEqual(["ack"]);
  });

  it("replay skips failing calls", () => {
    const s = replay([
      CASES.sequence,
      { steps: [{ op: "nope" }] },
      { steps: [{ op: "highlight", ids: ["ack"] }] },
    ]);
    expect(s.highlight).toEqual(["ack"]);
    expect(s.boxes.size).toBe(2);
  });
});

describe("layout: the highlight marker", () => {
  it("gives a highlighted box the marker fill and outline 3, and fades the rest", () => {
    let s = ok(emptyBoard(), CASES.vnet);
    s = ok(s, { steps: [{ op: "highlight", ids: ["gateway"] }] });
    const els = layout(s);
    expect(byId(els, "gateway")).toMatchObject({ backgroundColor: MARK, strokeWidth: 3 });
    expect(byId(els, "gateway").opacity).toBeUndefined();
    expect(byId(els, "web")).toMatchObject({
      backgroundColor: "#ffffff",
      strokeWidth: 2,
      opacity: 30,
    });
    expect(byId(els, "users-gateway")).toMatchObject({ opacity: 30 });
  });

  it("gives a highlighted arrow a marker patch behind its label and line 3", () => {
    const s = ok(emptyBoard(), CASES.sequence); // highlights "offer"
    const els = layout(s);
    expect(byId(els, "offer")).toMatchObject({ strokeWidth: 3 });
    expect(byId(els, "offer:label:bg")).toMatchObject({ backgroundColor: MARK });
    expect(byId(els, "discover:label:bg")).toMatchObject({ backgroundColor: "#ffffff" });
  });

  it("marks a highlighted group's frame, label patch and member boxes", () => {
    const s = ok(emptyBoard(), CASES.vnet); // highlights "db-subnet"
    const els = layout(s);
    expect(byId(els, "db-subnet")).toMatchObject({ strokeWidth: 2.5 });
    expect(byId(els, "db-subnet:label:bg")).toMatchObject({ backgroundColor: MARK });
    expect(byId(els, "db")).toMatchObject({ backgroundColor: MARK, strokeWidth: 3 });
    expect(markedIds(s)).toEqual(new Set(["db-subnet", "db"]));
  });

  it("keeps parts the same call added at full strength without a marker", () => {
    let s = ok(emptyBoard(), CASES.vnet);
    s = ok(s, {
      steps: [
        { op: "box", id: "cache", text: "Redis", row: 3, col: 2 },
        { op: "highlight", ids: ["db"] },
      ],
    });
    const cache = byId(layout(s), "cache");
    expect(cache.opacity).toBeUndefined();
    expect(cache.backgroundColor).toBe("#ffffff");
  });

  it("draws nothing faded without a highlight", () => {
    const s = ok(emptyBoard(), CASES.flowchart);
    expect(layout(s).some((e) => e.opacity !== undefined)).toBe(false);
  });
});

describe("layout: robustness", () => {
  it("skips an arrow to a group without member boxes (it has no frame yet)", () => {
    let s = ok(emptyBoard(), {
      steps: [
        { op: "board", id: "b", title: "B" },
        { op: "group", id: "vnet", text: "VNet" },
        { op: "box", id: "client", text: "Client", row: 0, col: 0 },
        { op: "arrow", from: "client", to: "vnet" },
      ],
    });
    expect(layout(s).some((e) => e.id === "client-vnet")).toBe(false);
    // A remove that empties a group an arrow points to draws, too.
    s = ok(emptyBoard(), CASES.vnet);
    s = ok(s, {
      steps: [
        { op: "arrow", from: "gateway", to: "db-subnet" },
        { op: "remove", ids: ["db"] },
      ],
    });
    expect(() => layout(s)).not.toThrow();
  });

  it("derived element ids never collide with a model's ids", () => {
    const s = ok(emptyBoard(), {
      steps: [
        { op: "board", id: "b", title: "B" },
        { op: "group", id: "vnet", text: "VNet" },
        { op: "box", id: "vnet-label", text: "X", row: 0, col: 0, in: "vnet" },
        { op: "box", id: "y", text: "Y", row: 0, col: 1, in: "vnet" },
        { op: "arrow", id: "y-label", from: "vnet-label", to: "y", text: "t" },
      ],
    });
    const ids = layout(s).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("layout: stability", () => {
  const position = (els: BoardElementSkeleton[], id: string) => {
    const e = byId(els, id);
    return [e.x, e.y, e.width, e.height];
  };

  it("adding a grid box moves no other box", () => {
    const s1 = ok(emptyBoard(), CASES.flowchart);
    const s2 = ok(s1, { steps: [{ op: "box", id: "log", text: "log(i)", row: 2, col: 2 }] });
    for (const id of ["start", "cond", "print", "end"]) {
      expect(position(layout(s2), id)).toEqual(position(layout(s1), id));
    }
  });

  it("adding a sequence participant and message moves nothing drawn before", () => {
    const s1 = ok(emptyBoard(), CASES.sequence);
    const s2 = ok(s1, {
      steps: [
        { op: "box", id: "server2", text: "Second server" },
        { op: "arrow", from: "server2", to: "laptop", text: "Offer 2" },
      ],
    });
    for (const id of ["laptop", "server", "discover", "offer", "ack"]) {
      expect(position(layout(s2), id)).toEqual(position(layout(s1), id));
    }
  });
});

describe("finish", () => {
  it("places anchored labels by their alignment and sizes their patch", () => {
    const els = finish([
      {
        id: "a:label",
        type: "text",
        x: 0,
        y: 0,
        width: 40,
        height: 20,
        customData: { anchor: [100, 50], align: "above" },
      },
      { id: "a:label:bg", type: "rectangle", x: 0, y: 0, width: 1, height: 1 },
      {
        id: "line",
        type: "line",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        customData: {
          points: [
            [0, 0],
            [10, 0],
            [10, 30],
          ],
        },
      },
    ]);
    expect(els[0]).toMatchObject({ x: 80, y: 30 });
    expect(els[1]).toMatchObject({ x: 76, y: 28, width: 48, height: 24 });
    expect(els[2]).toMatchObject({ width: 10, height: 30, roundness: null });
  });

  it("dims a box's bound label with its box", () => {
    const els = finish([
      { id: "box", type: "rectangle", x: 0, y: 0, width: 1, height: 1, opacity: 30 },
      { id: "t", type: "text", x: 0, y: 0, width: 1, height: 1, containerId: "box", opacity: 100 },
    ]);
    expect(els[1]?.opacity).toBe(30);
  });

  it("wraps words at the given width", () => {
    expect(wrap("a fairly long label here", 10)).toBe("a fairly\nlong label\nhere");
  });
});

describe("calls in message lists", () => {
  const input = CASES.sequence;

  it("finds applied board calls in stored Mastra messages, deduplicated", () => {
    const invocation = (id: string, result: unknown, toolName = "board") => ({
      type: "tool-invocation",
      toolInvocation: { state: "result", toolCallId: id, toolName, args: input, result },
    });
    const stored = [
      {
        role: "user",
        content: JSON.stringify({ format: 2, parts: [{ type: "text", text: "hi" }] }),
      },
      {
        role: "assistant",
        content: JSON.stringify({
          format: 2,
          parts: [
            invocation("c1", { ok: true, board: "…" }),
            invocation("c2", { ok: false, errors: ["x"] }),
            invocation("c3", { value: 1 }, "random_number"),
          ],
        }),
      },
      { role: "assistant", content: { format: 2, parts: [invocation("c1", { ok: true })] } },
      { role: "assistant", content: "not json" },
    ];
    expect(boardCallsFromStored(stored)).toEqual([{ id: "c1", input }]);
  });

  it("ignores calls still in the call state", () => {
    const stored = [
      {
        role: "assistant",
        content: {
          parts: [
            {
              type: "tool-invocation",
              toolInvocation: { state: "call", toolCallId: "c", toolName: "board", args: input },
            },
          ],
        },
      },
    ];
    expect(boardCallsFromStored(stored)).toEqual([]);
  });

  it("finds applied board calls in AG-UI messages", () => {
    const messages = [
      { id: "u", role: "user", content: "draw" },
      {
        id: "a",
        role: "assistant",
        toolCalls: [
          {
            id: "t1",
            type: "function",
            function: { name: "board", arguments: JSON.stringify(input) },
          },
          { id: "t2", type: "function", function: { name: "board", arguments: "{}" } },
          { id: "t3", type: "function", function: { name: "board", arguments: "{}" } },
        ],
      },
      {
        id: "r1",
        role: "tool",
        toolCallId: "t1",
        content: JSON.stringify({ ok: true, board: "…" }),
      },
      {
        id: "r2",
        role: "tool",
        toolCallId: "t2",
        content: JSON.stringify({ ok: false, errors: [] }),
      },
    ];
    expect(boardCallsFromAgui(messages)).toEqual([{ id: "t1", input }]);
  });

  it("reads results as objects or JSON strings", () => {
    expect(isAppliedResult({ ok: true })).toBe(true);
    expect(isAppliedResult('{"ok":true}')).toBe(true);
    expect(isAppliedResult('{"ok":false}')).toBe(false);
    expect(isAppliedResult("oops")).toBe(false);
    expect(isAppliedResult({ error: true, message: "validation failed" })).toBe(false);
  });
});

describe("chat markers", () => {
  const call = (id: string) => ({
    id,
    type: "function",
    function: { name: "board", arguments: JSON.stringify(CASES.flowchart) },
  });
  const result = (id: string, ok: boolean) => ({
    id: `${id}-r`,
    role: "tool",
    toolCallId: id,
    content: JSON.stringify(ok ? { ok: true, board: "" } : { ok: false, errors: [] }),
  });

  it("shows one marker per reply: Drew for the first drawing, Changed later, none when rejected", () => {
    const messages = [
      { id: "a1", role: "assistant", toolCalls: [call("x1"), call("x2")] },
      result("x1", true),
      result("x2", true),
      { id: "a2", role: "assistant", toolCalls: [call("x3")] },
      result("x3", false),
      { id: "a3", role: "assistant", toolCalls: [call("x4"), call("x5")] },
      result("x4", true),
      result("x5", false),
    ];
    expect(boardPillLabels(messages)).toEqual(
      new Map([
        ["x2", "Drew on the board"],
        ["x4", "Changed the board"],
      ]),
    );
  });
});

describe("describe", () => {
  it("words the first drawing and later changes", () => {
    const s1 = ok(emptyBoard(), CASES.flowchart);
    expect(changeStatus(null, s1)).toBe("Drawn just now");
    expect(changeStatus(emptyBoard(), s1)).toBe("Drawn just now");
    const s2 = ok(s1, {
      steps: [
        { op: "box", id: "log", text: "log", row: 2, col: 2 },
        { op: "arrow", from: "print", to: "log" },
        { op: "highlight", ids: ["cond", "print", "end"] },
      ],
    });
    expect(changeStatus(s1, s2)).toBe("Added 2 parts, highlighted 3 parts");
    const s3 = ok(s2, { steps: [{ op: "highlight", ids: ["cond"] }] });
    expect(changeStatus(s2, s3)).toBe("Highlighted 1 part");
  });

  it("builds a plain-text alternative from the model", () => {
    const text = describeBoard(ok(emptyBoard(), CASES.sequence));
    expect(text).toContain('Drawing "DHCP: DORA".');
    expect(text).toContain("Parts: Laptop (no IP yet), DHCP server.");
    expect(text).toContain("DHCP server → Laptop (no IP yet) (2 Offer: 10.0.0.23)");
    expect(text).toContain("Highlighted: 2 Offer: 10.0.0.23.");
  });
});
