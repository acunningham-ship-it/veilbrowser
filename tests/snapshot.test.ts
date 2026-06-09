/**
 * Unit tests for AX-tree snapshot ref numbering.
 *
 * The snapshot mechanism is core to Veil's agent-first design: elements get a
 * stable integer `ref` that agents use instead of CSS/XPath selectors. This test
 * validates that the ref numbering is consistent and correct.
 *
 * Run with: bun test tests/snapshot.test.ts
 */
import { describe, it, expect } from "bun:test";

/**
 * Simulate the snapshot element filtering logic from page.ts.
 * This is the pure ref-numbering logic, extracted and testable without a browser.
 */
function buildRefs(nodes: any[]): { ref: number; role: string; name: string }[] {
  const INTERESTING = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
    "menuitem", "menuitemcheckbox", "tab", "switch", "slider", "option",
    "listbox", "spinbutton", "textarea",
  ]);

  const result: { ref: number; role: string; name: string }[] = [];
  let ref = 0;

  for (const n of nodes) {
    if (n.ignored) continue;
    const role: string = n.role?.value ?? "";
    const name: string = (n.name?.value ?? "").trim();

    if (!INTERESTING.has(role)) continue;
    if (!name && role !== "textbox" && role !== "searchbox" && role !== "textarea") continue;
    if (!n.backendDOMNodeId) continue;

    ref++;
    result.push({ ref, role, name });
  }

  return result;
}

describe("snapshot ref numbering", () => {
  it("refs start at 1, not 0", () => {
    const nodes = [
      { ignored: false, role: { value: "button" }, name: { value: "Click me" }, backendDOMNodeId: 100 },
    ];
    const elems = buildRefs(nodes);
    expect(elems).toHaveLength(1);
    expect(elems[0].ref).toBe(1);
  });

  it("refs are sequential with no gaps", () => {
    const nodes = [
      { ignored: false, role: { value: "button" }, name: { value: "A" }, backendDOMNodeId: 1 },
      { ignored: false, role: { value: "textbox" }, name: { value: "" }, backendDOMNodeId: 2 },
      { ignored: false, role: { value: "button" }, name: { value: "B" }, backendDOMNodeId: 3 },
    ];
    const elems = buildRefs(nodes);
    expect(elems).toHaveLength(3);
    for (let i = 0; i < elems.length; i++) {
      expect(elems[i].ref).toBe(i + 1);
    }
  });

  it("skips ignored nodes", () => {
    const nodes = [
      { ignored: false, role: { value: "button" }, name: { value: "A" }, backendDOMNodeId: 1 },
      { ignored: true, role: { value: "button" }, name: { value: "hidden" }, backendDOMNodeId: 2 },
      { ignored: false, role: { value: "button" }, name: { value: "B" }, backendDOMNodeId: 3 },
    ];
    const elems = buildRefs(nodes);
    expect(elems).toHaveLength(2);
    expect(elems[0].name).toBe("A");
    expect(elems[1].name).toBe("B");
    expect(elems[1].ref).toBe(2);
  });

  it("skips uninteresting roles", () => {
    const nodes = [
      { ignored: false, role: { value: "button" }, name: { value: "Click" }, backendDOMNodeId: 1 },
      { ignored: false, role: { value: "generic" }, name: { value: "Some div" }, backendDOMNodeId: 2 },
      { ignored: false, role: { value: "link" }, name: { value: "Link" }, backendDOMNodeId: 3 },
    ];
    const elems = buildRefs(nodes);
    expect(elems).toHaveLength(2);
    expect(elems[0].role).toBe("button");
    expect(elems[1].role).toBe("link");
  });

  it("allows textbox/searchbox/textarea without name", () => {
    const nodes = [
      { ignored: false, role: { value: "textbox" }, name: { value: "" }, backendDOMNodeId: 1 },
      { ignored: false, role: { value: "button" }, name: { value: "" }, backendDOMNodeId: 2 }, // button needs a name
      { ignored: false, role: { value: "searchbox" }, name: { value: "" }, backendDOMNodeId: 3 },
    ];
    const elems = buildRefs(nodes);
    expect(elems).toHaveLength(2);
    expect(elems[0].role).toBe("textbox");
    expect(elems[1].role).toBe("searchbox");
  });

  it("skips nodes with no backendDOMNodeId", () => {
    const nodes = [
      { ignored: false, role: { value: "button" }, name: { value: "A" }, backendDOMNodeId: 1 },
      { ignored: false, role: { value: "button" }, name: { value: "B" } }, // no backendDOMNodeId
      { ignored: false, role: { value: "button" }, name: { value: "C" }, backendDOMNodeId: 3 },
    ];
    const elems = buildRefs(nodes);
    expect(elems).toHaveLength(2);
    expect(elems[0].name).toBe("A");
    expect(elems[1].name).toBe("C");
    expect(elems[1].ref).toBe(2); // numbering still sequential
  });
});
