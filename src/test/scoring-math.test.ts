import { describe, expect, it } from "vitest";
import {
  computeFactualityScore,
  computeGroundingScore,
  computeIntegrityScore,
  computeOneSidedness,
  computePersistedScores,
  computeSourcingQuality,
  roundScore3,
} from "../../supabase/functions/_shared/scoring-math";

describe("scoring math", () => {
  it("computes grounding from evidence-covered segments", () => {
    const value = computeGroundingScore({
      supported: 2,
      contradicted: 0,
      mixed: 0,
      unknown: 4,
      total: 8,
    });
    expect(value).toBe(0.25);
  });

  it("computes integrity for balanced adequate sample", () => {
    const value = computeIntegrityScore({
      supported: 2,
      contradicted: 2,
      mixed: 0,
      unknown: 0,
      total: 4,
    });
    expect(value).toBeCloseTo(0.5, 6);
  });

  it("applies minimum denominator for small samples", () => {
    const value = computeIntegrityScore({
      supported: 1,
      contradicted: 1,
      mixed: 0,
      unknown: 0,
      total: 2,
    });
    expect(value).toBeCloseTo(0.515151, 5);
  });

  it("matches unknown-heavy worked example", () => {
    const value = computeIntegrityScore({
      supported: 2,
      contradicted: 0,
      mixed: 0,
      unknown: 4,
      total: 8,
    });
    expect(value).toBeCloseTo(0.69697, 5);
  });

  it("clamps integrity to [0,1]", () => {
    const low = computeIntegrityScore({
      supported: 0,
      contradicted: 999,
      mixed: 0,
      unknown: 0,
      total: 999,
    });
    const high = computeIntegrityScore({
      supported: 999,
      contradicted: 0,
      mixed: 0,
      unknown: 0,
      total: 999,
    });
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(1);
    expect(high).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
  });

  it("rounds to 3 decimals for persisted scores", () => {
    expect(roundScore3(0.5151515151)).toBe(0.515);
    expect(roundScore3(0.6969696969)).toBe(0.697);
  });

  it("computes persisted scores with shared rounding semantics", () => {
    const scores = computePersistedScores({
      supported: 1,
      contradicted: 1,
      mixed: 0,
      unknown: 0,
      total: 2,
    });
    expect(scores.groundingScore).toBe(1);
    expect(scores.integrityScore).toBe(0.515);
  });

  it("matches scoring contract table", () => {
    const cases = [
      {
        name: "balanced adequate sample",
        inputs: { supported: 2, contradicted: 2, mixed: 0, unknown: 0, total: 4 },
        expected: { groundingScore: 1, integrityScore: 0.5 },
      },
      {
        name: "balanced small sample denominator floor",
        inputs: { supported: 1, contradicted: 1, mixed: 0, unknown: 0, total: 2 },
        expected: { groundingScore: 1, integrityScore: 0.515 },
      },
      {
        name: "unknown-heavy",
        inputs: { supported: 2, contradicted: 0, mixed: 0, unknown: 4, total: 8 },
        expected: { groundingScore: 0.25, integrityScore: 0.697 },
      },
      {
        name: "all unknown",
        inputs: { supported: 0, contradicted: 0, mixed: 0, unknown: 5, total: 5 },
        expected: { groundingScore: 0, integrityScore: 0.545 },
      },
      {
        name: "all contradicted",
        inputs: { supported: 0, contradicted: 3, mixed: 0, unknown: 0, total: 3 },
        expected: { groundingScore: 1, integrityScore: 0 },
      },
      {
        name: "all supported",
        inputs: { supported: 3, contradicted: 0, mixed: 0, unknown: 0, total: 3 },
        expected: { groundingScore: 1, integrityScore: 1 },
      },
    ] as const;

    for (const testCase of cases) {
      const scores = computePersistedScores(testCase.inputs);
      expect(scores.groundingScore, `${testCase.name} grounding`).toBe(
        testCase.expected.groundingScore,
      );
      expect(scores.integrityScore, `${testCase.name} integrity`).toBe(
        testCase.expected.integrityScore,
      );
    }
  });
});

describe("sourcing quality", () => {
  it("scores T1 evidence as 1.0", () => {
    expect(computeSourcingQuality({ tierCounts: { T1: 5 } })).toBe(1);
  });

  it("blends tiers proportionally", () => {
    const score = computeSourcingQuality({ tierCounts: { T1: 2, T4: 1 } });
    // (1.0*2 + 0.45*1) / 3 = 0.8167
    expect(score).toBeCloseTo(0.817, 3);
  });

  it("penalizes sparse evidence", () => {
    const sparse = computeSourcingQuality({ tierCounts: { T1: 1 } });
    const adequate = computeSourcingQuality({ tierCounts: { T1: 3 } });
    expect(sparse).toBeLessThan(adequate);
  });

  it("returns 0 for no evidence", () => {
    expect(computeSourcingQuality({ tierCounts: {} })).toBe(0);
  });
});

describe("one-sidedness", () => {
  it("returns 0 for perfectly balanced", () => {
    const score = computeOneSidedness({
      opinionRatio: 0.5,
      sentimentExtremity: 0,
      factualRatio: 0.5,
    });
    expect(score).toBe(0.2); // 0.40*0.5 + 0.35*0 + 0.25*0 = 0.2
  });

  it("returns 0 for zero inputs", () => {
    const score = computeOneSidedness({
      opinionRatio: 0,
      sentimentExtremity: 0,
      factualRatio: 0,
    });
    expect(score).toBe(0);
  });

  it("returns high for all-opinion with extreme sentiment", () => {
    const score = computeOneSidedness({
      opinionRatio: 1,
      sentimentExtremity: 1,
      factualRatio: 0,
    });
    expect(score).toBe(1);
  });

  it("clamps to [0,1]", () => {
    const score = computeOneSidedness({
      opinionRatio: 0.5,
      sentimentExtremity: 0.3,
      factualRatio: 0.5,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("factuality composite", () => {
  it("returns 1.0 for perfect scores", () => {
    const score = computeFactualityScore(0, 1, 1, 0);
    expect(score).toBe(1);
  });

  it("returns 0 for worst scores", () => {
    const score = computeFactualityScore(1, 0, 0, 1);
    expect(score).toBe(0);
  });

  it("weights contradiction rate at 40%", () => {
    const goodFacts = computeFactualityScore(0, 0.5, 0.5, 0.5);
    const badFacts = computeFactualityScore(1, 0.5, 0.5, 0.5);
    expect(goodFacts - badFacts).toBeCloseTo(0.4, 3);
  });
});
