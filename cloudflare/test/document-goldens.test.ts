import manifest from "../fixtures/documents/document-goldens.json";
import { describe, expect, it } from "vitest";
import { documentGoldenCases } from "./fixtures/document-golden-cases";

describe("document structural and visual goldens", () => {
  for (const documentCase of documentGoldenCases) {
    it(`keeps ${documentCase.name} HTML tied to its inspected PDF and PNG baseline`, async () => {
      const golden = manifest.documents.find((entry) => entry.name === documentCase.name);
      expect(golden).toBeDefined();
      expect(await sha256(documentCase.html)).toBe(golden?.htmlSha256);
      expect(golden?.expectedText).toEqual(documentCase.expectedText);
      expect(golden?.rowCount).toBe(documentCase.rowCount);
      expect(golden?.pageCount).toBeGreaterThanOrEqual(documentCase.minimumPages);
      expect(golden?.pageWidthPoints).toBeGreaterThan(594);
      expect(golden?.pageWidthPoints).toBeLessThan(596);
      expect(golden?.pageHeightPoints).toBeGreaterThan(841);
      expect(golden?.pageHeightPoints).toBeLessThan(843);
      expect(golden?.outOfBoundsCharacters).toBe(0);
      expect(golden?.extractedCharacterCount).toBeGreaterThan(100);
      expect(golden?.extractedTextSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(golden?.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(golden?.pages).toHaveLength(golden?.pageCount ?? 0);
      for (const page of golden?.pages ?? []) {
        expect(page.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(page.width).toBeGreaterThan(1_000);
        expect(page.height).toBeGreaterThan(1_500);
      }
      expect(documentCase.html.match(/<tbody>/g)).toHaveLength(1);
      expect(documentCase.html.match(/<tr>/g)).toHaveLength(documentCase.rowCount + 1);
      expect(documentCase.html).toContain("@page{size:A4;margin:12mm}");
      expect(documentCase.html).not.toMatch(/<script|javascript:/i);
    });
  }
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
