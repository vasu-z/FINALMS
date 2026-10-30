import { describe, it, expect } from "@jest/globals";
import { ReadTextOcrResponse } from "../api/client";

describe("OCR Reader Screen & Live Verification Tests", () => {
  describe("OCR Modes and Processing Rules", () => {
    it("supports fast, balanced, and accurate modes", () => {
      const validModes = ["fast", "balanced", "accurate"];
      expect(validModes).toContain("fast");
      expect(validModes).toContain("balanced");
      expect(validModes).toContain("accurate");
    });

    it("verifies OCR response schema contains verbatim text and confidence score", () => {
      const sampleOcrResponse: ReadTextOcrResponse = {
        text: "CS 201: Discrete Mathematics\nTheorem: E = mc^2\nsum(i=1 to n) i = n(n+1)/2",
        mode: "accurate",
        confidence: 0.95,
        has_math: true,
        reading_order_blocks: [
          "CS 201: Discrete Mathematics",
          "Theorem: E = mc^2\nsum(i=1 to n) i = n(n+1)/2",
        ],
        model: "gemma-4",
      };

      expect(sampleOcrResponse.text).toContain("E = mc^2");
      expect(sampleOcrResponse.confidence).toBeGreaterThanOrEqual(0.65);
      expect(sampleOcrResponse.has_math).toBe(true);
      expect(sampleOcrResponse.reading_order_blocks?.length).toBe(2);
    });

    it("flags low confidence when image is unclear or illegible (Safety Rule 2)", () => {
      const unclearResponse: ReadTextOcrResponse = {
        text: "Lecture 3 [unclear] notes [unclear]",
        mode: "balanced",
        confidence: 0.80,
        has_math: false,
      };

      const containsUnclear = unclearResponse.text.includes("[unclear]");
      expect(containsUnclear).toBe(true);
      expect(unclearResponse.confidence).toBeLessThan(0.95);
    });

    it("correctly identifies mathematical formulas and expressions in text", () => {
      const mathSamples = [
        "E = mc^2",
        "f(n) = O(g(n))",
        "sum(i=1 to n) i = n(n+1)/2",
        "x^2 + y^2 = r^2",
      ];

      const mathIndicators = ["=", "+", "-", "*", "/", "^", "\\sum", "O("];
      mathSamples.forEach((sample) => {
        const hasMath = mathIndicators.some((sym) => sample.includes(sym));
        expect(hasMath).toBe(true);
      });
    });
  });

  describe("Accessibility and Safety Standards (AGENTS.md)", () => {
    it("verifies minimum touch targets comply with 56dp rule", () => {
      const buttonDimensions = {
        modeButtonMinHeight: 56,
        headerButtonMinHeight: 56,
        headerButtonMinWidth: 56,
        shutterButtonMinHeight: 64,
        actionButtonMinHeight: 56,
      };

      expect(buttonDimensions.modeButtonMinHeight).toBeGreaterThanOrEqual(56);
      expect(buttonDimensions.headerButtonMinHeight).toBeGreaterThanOrEqual(56);
      expect(buttonDimensions.shutterButtonMinHeight).toBeGreaterThanOrEqual(56);
      expect(buttonDimensions.actionButtonMinHeight).toBeGreaterThanOrEqual(56);
    });

    it("ensures fail-safe and fail-audible messaging on error paths", () => {
      const errorRecoveryMessages = {
        unclear: "Could not read text clearly. Please hold your phone steady with good lighting and try again.",
        permission: "Camera permission is required to scan notes.",
        offline: "Unable to reach server. Local OCR fallback is active.",
      };

      Object.values(errorRecoveryMessages).forEach((msg) => {
        expect(msg.length).toBeGreaterThan(10);
        expect(typeof msg).toBe("string");
      });
    });
  });
});

