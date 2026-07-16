import { describe, it, expect } from "vitest";
import { formatDateTime } from "@/utils/formatDateTime";

describe("formatDateTime", () => {
  it("returns empty string for empty input so callers keep their own fallback", () => {
    expect(formatDateTime("")).toBe("");
  });

  it("returns empty string for an unparseable date", () => {
    expect(formatDateTime("not-a-date")).toBe("");
  });

  it("renders a valid ISO timestamp without the raw ISO markers (T/Z)", () => {
    const out = formatDateTime("2026-07-16T00:27:01.661Z");
    expect(out).not.toBe("");
    // Proves the UTC ISO string was reformatted for local display, not echoed back.
    expect(out).not.toContain("T");
    expect(out).not.toContain("Z");
    expect(out).not.toContain("2026-07-16");
  });

  it("produces the same output as the browser's toLocaleString for that instant", () => {
    const iso = "2026-07-16T00:27:01.661Z";
    const expected = new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    });
    expect(formatDateTime(iso)).toBe(expected);
  });
});
