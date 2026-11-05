import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

export const assessmentSkillStatuses = [
  "mastered",
  "developing",
  "not_yet_demonstrated",
  "needs_verification",
  "not_assessed",
] as const;

const findingSchema = z
  .object({
    skillName: z.string().trim().min(1).max(240),
    domainName: z.string().trim().min(1).max(240),
    testedState: z.enum(["tested", "not_tested", "unclear"]),
    proposedStatus: z.enum(assessmentSkillStatuses),
    statusBasis: z.enum([
      "provider_explicit",
      "multiple_items",
      "single_item",
      "partial_result",
      "insufficient_evidence",
      "not_tested",
    ]),
    providerReportedStatus: z.string().trim().max(500).nullable(),
    confidence: z.enum(["high", "medium", "low"]),
    evidenceSummary: z.string().trim().min(1).max(2000),
    sourceLocator: z.string().trim().min(1).max(500),
    originalResult: z.string().trim().min(1).max(2000),
  })
  .strict();

export const assessmentExtractionSchema = z
  .object({
    assessmentName: z.string().trim().max(240).nullable(),
    provider: z.string().trim().max(240).nullable(),
    subject: z.string().trim().max(160).nullable(),
    assessmentDate: z.string().date().nullable(),
    domains: z.array(z.string().trim().min(1).max(240)).max(100),
    scores: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(240),
            value: z.string().trim().min(1).max(240),
            unit: z.string().trim().max(120).nullable(),
            meaning: z.string().trim().max(1000).nullable(),
            domain: z.string().trim().max(240).nullable(),
            sourceLocator: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(200),
    providerStrengths: z.array(z.string().trim().min(1).max(1000)).max(100),
    providerDifficulties: z.array(z.string().trim().min(1).max(1000)).max(100),
    narrativeObservations: z.array(z.string().trim().min(1).max(1000)).max(100),
    findings: z.array(findingSchema).max(300),
  })
  .strict()
  .superRefine((value, context) => {
    value.findings.forEach((finding, index) => {
      if (finding.testedState === "not_tested" && finding.proposedStatus !== "not_assessed") {
        context.addIssue({
          code: "custom",
          message: "A skill that was not tested must be marked not_assessed.",
          path: ["findings", index, "proposedStatus"],
        });
      }

      if (
        finding.proposedStatus === "mastered" &&
        (finding.statusBasis !== "provider_explicit" || !finding.providerReportedStatus)
      ) {
        context.addIssue({
          code: "custom",
          message: "Mastered requires an explicit provider-reported result.",
          path: ["findings", index, "proposedStatus"],
        });
      }

      if (
        ["single_item", "partial_result", "insufficient_evidence"].includes(finding.statusBasis) &&
        !["needs_verification", "not_assessed"].includes(finding.proposedStatus)
      ) {
        context.addIssue({
          code: "custom",
          message: "Sparse evidence cannot support a definitive skill status.",
          path: ["findings", index, "proposedStatus"],
        });
      }
    });
  });

const evidenceBulletSchema = z
  .object({
    statement: z.string().trim().min(1).max(500),
    evidence: z.string().trim().min(1).max(1000),
  })
  .strict();

export const learnerAcademicSummarySchema = z
  .object({
    strengths: z.array(evidenceBulletSchema).max(6),
    areasOfGrowth: z.array(evidenceBulletSchema).max(6),
    teachingMethods: z.array(evidenceBulletSchema).max(6),
  })
  .strict();

export type AssessmentExtraction = z.infer<typeof assessmentExtractionSchema>;
export type LearnerAcademicSummary = z.infer<typeof learnerAcademicSummarySchema>;

export type SummaryEvidenceContext = {
  learner: {
    displayName: string;
    gradeLevel: string | null;
  };
  profile: Record<string, unknown> | null;
  approvedFindings: Array<Record<string, unknown>>;
  parentObservations: Array<Record<string, unknown>>;
  priorities: Array<Record<string, unknown>>;
};

export function getAiConfiguration() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim();

  if (!apiKey || !model) {
    return null;
  }

  return { apiKey, model };
}

export async function extractAssessmentFile(input: {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}) {
  const configuration = getAiConfiguration();
  if (!configuration) {
    throw new Error("Assessment processing is unavailable because the AI provider is not configured.");
  }

  const client = new OpenAI({ apiKey: configuration.apiKey });
  const fileData = `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`;
  const response = await client.responses.parse({
    model: configuration.model,
    instructions: ASSESSMENT_EXTRACTION_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Extract only the assessment facts and evidence-supported skill findings in this source file.",
          },
          {
            type: "input_file",
            file_data: fileData,
            filename: input.filename,
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(assessmentExtractionSchema, "assessment_extraction"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("The AI provider returned no validated assessment extraction.");
  }

  return {
    extraction: response.output_parsed,
    providerName: "OpenAI",
    modelName: configuration.model,
  };
}

export async function generateLearnerAcademicSummary(context: SummaryEvidenceContext) {
  const configuration = getAiConfiguration();
  if (!configuration) {
    throw new Error("Summary generation is unavailable because the AI provider is not configured.");
  }

  const client = new OpenAI({ apiKey: configuration.apiKey });
  const response = await client.responses.parse({
    model: configuration.model,
    instructions: SUMMARY_GENERATION_INSTRUCTIONS,
    input: JSON.stringify(context),
    text: {
      format: zodTextFormat(learnerAcademicSummarySchema, "learner_academic_summary"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("The AI provider returned no validated learner summary.");
  }

  return {
    summary: response.output_parsed,
    providerName: "OpenAI",
    modelName: configuration.model,
  };
}

const ASSESSMENT_EXTRACTION_INSTRUCTIONS = `
You extract structured facts from a learner assessment report. You do not diagnose, award mastery,
calculate XP, or infer facts that the report does not establish.

Preserve the source's original score units and meaning. Distinguish statements printed by the provider
from your interpretation. Every finding must cite a source locator such as a page, section, row, or item.

Use these status rules exactly:
- not_assessed: the report says or shows that the skill was not tested.
- needs_verification: evidence is unclear, partial, or comes from only one or two questions.
- developing or not_yet_demonstrated: only when repeated item-level evidence or an explicit provider result supports it.
- mastered: only when the provider explicitly reports mastery or an equivalent status for that exact skill.

Never turn a missing score into a weakness. Never generalize one or two missed questions into a broad skill
deficit. When evidence and provider wording conflict or are ambiguous, use needs_verification and low confidence.
`;

const SUMMARY_GENERATION_INSTRUCTIONS = `
Create three short bullet lists from only the supplied inputs: strengths, areas of growth, and teaching methods.
Return no more than six bullets in each list. Each bullet must make one concise statement and identify the exact
supporting input in its evidence field, including a provider result or the date and parent-reported provenance of
an observation when available. Do not combine unrelated inputs into a generalized claim.

Treat approved provider findings, parent observations, learner profile context, and priorities as separate
sources. Parent observations are context, not objective assessment results. Areas of growth must be supported by
tested evidence; never turn a missing or unassessed result into a weakness. Do not diagnose, award mastery,
calculate XP, or claim that session duration proves quality. Use teaching methods only when an input supports the
approach; otherwise return an empty list. Keep every statement specific, supportive, and direct.
`;
