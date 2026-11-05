import { describe, expect, it } from "vitest";

import {
  assessmentExtractionSchema,
  learnerAcademicSummarySchema,
} from "./learner-profile-ai";

const baseExtraction = {
  assessmentName: "Sample Reading Report",
  provider: "Sample Provider",
  subject: "Reading",
  assessmentDate: "2026-10-20",
  domains: ["Phonics"],
  scores: [],
  providerStrengths: [],
  providerDifficulties: [],
  narrativeObservations: [],
  findings: [
    {
      skillName: "Short vowels",
      domainName: "Phonics",
      testedState: "tested" as const,
      proposedStatus: "developing" as const,
      statusBasis: "multiple_items" as const,
      providerReportedStatus: null,
      confidence: "medium" as const,
      evidenceSummary: "The learner answered six of eight short-vowel items correctly.",
      sourceLocator: "Page 2, Short vowels row",
      originalResult: "6 of 8 correct",
    },
  ],
};

describe("assessmentExtractionSchema", () => {
  it("accepts an evidence-supported developing finding", () => {
    expect(assessmentExtractionSchema.safeParse(baseExtraction).success).toBe(true);
  });

  it("requires untested skills to remain not assessed", () => {
    const result = assessmentExtractionSchema.safeParse({
      ...baseExtraction,
      findings: [
        {
          ...baseExtraction.findings[0],
          testedState: "not_tested",
          proposedStatus: "not_yet_demonstrated",
          statusBasis: "not_tested",
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects mastery without an explicit provider result", () => {
    const result = assessmentExtractionSchema.safeParse({
      ...baseExtraction,
      findings: [
        {
          ...baseExtraction.findings[0],
          proposedStatus: "mastered",
          statusBasis: "multiple_items",
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("requires verification for sparse evidence", () => {
    const result = assessmentExtractionSchema.safeParse({
      ...baseExtraction,
      findings: [
        {
          ...baseExtraction.findings[0],
          proposedStatus: "developing",
          statusBasis: "single_item",
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe("learnerAcademicSummarySchema", () => {
  it("requires concise bullets with explicit supporting evidence", () => {
    expect(
      learnerAcademicSummarySchema.safeParse({
        strengths: [
          {
            statement: "Uses vowel cards independently.",
            evidence: "Parent-reported reading observation dated 2026-11-04.",
          },
        ],
        areasOfGrowth: [
          {
            statement: "Short-vowel decoding is developing.",
            evidence: "Sample Provider report: 6 of 8 short-vowel items correct.",
          },
        ],
        teachingMethods: [],
      }).success,
    ).toBe(true);
  });

  it("rejects the previous prose-section format", () => {
    expect(
      learnerAcademicSummarySchema.safeParse({
        strengths: "Uses vowel cards independently.",
        areasOfGrowth: "Short-vowel decoding is developing.",
        teachingMethods: "Use vowel cards.",
      }).success,
    ).toBe(false);
  });
});
