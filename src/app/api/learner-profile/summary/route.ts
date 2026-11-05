import { z } from "zod";

import { generateLearnerAcademicSummary, getAiConfiguration } from "@/lib/learner-profile-ai";
import { authorizeParentRequest, parentOwnsLearner } from "@/lib/parent-api";

const generateSchema = z.object({ learnerId: z.string().uuid() }).strict();
const approveSchema = z
  .object({ learnerId: z.string().uuid(), summaryId: z.string().uuid() })
  .strict();

export async function POST(request: Request) {
  const authorization = await authorizeParentRequest(request, { requireSecret: true });
  if (!authorization.context) return authorization.response;

  let learnerId: string;
  try {
    learnerId = generateSchema.parse(await request.json()).learnerId;
  } catch {
    return Response.json({ error: "Choose a valid learner." }, { status: 400 });
  }
  if (!(await parentOwnsLearner(authorization.context, learnerId))) {
    return Response.json({ error: "Learner not found." }, { status: 404 });
  }
  const configuration = getAiConfiguration();
  if (!configuration) {
    return Response.json(
      { error: "Summary generation is unavailable because the AI provider is not configured." },
      { status: 503 },
    );
  }

  const { admin, userId } = authorization.context;
  if (!admin) return Response.json({ error: "Summary generation is not configured." }, { status: 503 });
  const [learnerResult, profileResult, assessmentsResult, observationsResult, prioritiesResult, priorSummaryResult] =
    await Promise.all([
      admin.from("learners").select("display_name").eq("id", learnerId).eq("user_id", userId).single(),
      admin.from("learner_profiles").select("date_of_birth, educational_level, interests, learning_preferences, observed_strengths, observed_challenges, motivators, helpful_approaches, additional_notes").eq("learner_id", learnerId).eq("user_id", userId).maybeSingle(),
      admin.from("learner_assessments").select("id, assessment_name, provider, subject, assessment_date").eq("learner_id", learnerId).eq("user_id", userId).eq("processing_status", "approved"),
      admin.from("learner_observations").select("id, observation_date, subject, observation_text, related_skill, provenance").eq("learner_id", learnerId).eq("user_id", userId).order("observation_date", { ascending: false }),
      admin.from("learner_priorities").select("id, title, subject, notes").eq("learner_id", learnerId).eq("user_id", userId).eq("active", true),
      admin.from("learner_academic_summaries").select("id, version, learner_overview, strengths, developing_skills, learning_patterns, areas_to_investigate, teaching_recommendations, parent_context").eq("learner_id", learnerId).eq("user_id", userId).eq("status", "approved").maybeSingle(),
    ]);
  const loadError = [learnerResult, profileResult, assessmentsResult, observationsResult, prioritiesResult, priorSummaryResult].find((result) => result.error)?.error;
  if (loadError || !learnerResult.data) {
    return Response.json({ error: "Summary evidence could not be loaded." }, { status: 500 });
  }

  const assessments = assessmentsResult.data ?? [];
  const assessmentIds = assessments.map((assessment) => assessment.id);
  const findingsResult = assessmentIds.length
    ? await admin
        .from("assessment_findings")
        .select("id, assessment_id, skill_name, domain, original_provider_result, provider_reported_status, tested_state, ai_interpretation, supporting_evidence, proposed_status, status_basis, confidence, parent_correction, parent_status_override")
        .in("assessment_id", assessmentIds)
        .eq("user_id", userId)
        .eq("parent_approved", true)
    : { data: [], error: null };
  if (findingsResult.error) {
    return Response.json({ error: "Approved findings could not be loaded." }, { status: 500 });
  }

  const approvedFindings = findingsResult.data ?? [];
  const observations = observationsResult.data ?? [];
  if (approvedFindings.length === 0 && observations.length === 0) {
    return Response.json(
      { error: "Add an observation or approve assessment findings before generating a summary." },
      { status: 400 },
    );
  }

  const evidenceSnapshot = {
    profile: profileResult.data,
    assessments,
    approvedFindings,
    parentObservations: observations,
    priorities: prioritiesResult.data ?? [],
    priorApprovedSummary: priorSummaryResult.data,
  };
  const minimizedFindings = approvedFindings.map((finding) => {
    const assessment = assessments.find((candidate) => candidate.id === finding.assessment_id);
    return {
      assessment: assessment
        ? {
            name: assessment.assessment_name,
            provider: assessment.provider,
            subject: assessment.subject,
            date: assessment.assessment_date,
          }
        : null,
      skillName: finding.skill_name,
      domain: finding.domain,
      originalProviderResult: finding.original_provider_result,
      providerReportedStatus: finding.provider_reported_status,
      testedState: finding.tested_state,
      aiInterpretation: finding.ai_interpretation,
      supportingEvidence: finding.supporting_evidence,
      proposedStatus: finding.proposed_status,
      statusBasis: finding.status_basis,
      confidence: finding.confidence,
      parentCorrection: finding.parent_correction,
      parentStatusOverride: finding.parent_status_override,
    };
  });
  const minimizedObservations = observations.map((observation) => ({
    observationDate: observation.observation_date,
    subject: observation.subject,
    observationText: observation.observation_text,
    relatedSkill: observation.related_skill,
    provenance: observation.provenance,
  }));
  try {
    const result = await generateLearnerAcademicSummary({
      learner: {
        displayName: learnerResult.data.display_name,
        gradeLevel: profileResult.data?.educational_level ?? null,
      },
      profile: profileResult.data,
      approvedFindings: minimizedFindings,
      parentObservations: minimizedObservations,
      priorities: (prioritiesResult.data ?? []).map((priority) => ({
        title: priority.title,
        subject: priority.subject,
        notes: priority.notes,
      })),
    });
    const formatBullets = (
      bullets: Array<{ statement: string; evidence: string }>,
    ) => bullets.map((bullet) => `${bullet.statement} — Evidence: ${bullet.evidence}`).join("\n");
    const persistedSummary = {
      learnerOverview: "",
      strengths: formatBullets(result.summary.strengths),
      developingSkills: formatBullets(result.summary.areasOfGrowth),
      learningPatterns: "",
      areasToInvestigate: "",
      teachingRecommendations: formatBullets(result.summary.teachingMethods),
      parentContext: "",
    };
    const { data: summaryId, error } = await admin.rpc("record_learner_summary_draft", {
      p_user_id: userId,
      p_learner_id: learnerId,
      p_summary: persistedSummary,
      p_evidence_snapshot: evidenceSnapshot,
      p_provider_name: result.providerName,
      p_model_name: result.modelName,
      p_assessment_ids: assessmentIds,
      p_observation_ids: observations.map((observation) => observation.id),
      p_prior_summary_id: priorSummaryResult.data?.id ?? null,
    });
    if (error || typeof summaryId !== "string") {
      throw new Error("The validated summary draft could not be stored.");
    }
    return Response.json({ summaryId, status: "draft" });
  } catch {
    return Response.json(
      { error: "The summary draft could not be generated. Existing approved summaries were not changed." },
      { status: 502 },
    );
  }
}

export async function PATCH(request: Request) {
  const authorization = await authorizeParentRequest(request, { requireSecret: true });
  if (!authorization.context) return authorization.response;

  let approval: z.infer<typeof approveSchema>;
  try {
    approval = approveSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Choose a valid summary draft." }, { status: 400 });
  }
  if (!(await parentOwnsLearner(authorization.context, approval.learnerId))) {
    return Response.json({ error: "Learner not found." }, { status: 404 });
  }

  const { admin, userId } = authorization.context;
  if (!admin) return Response.json({ error: "Summary approval is not configured." }, { status: 503 });
  const { error } = await admin.rpc("approve_learner_summary", {
    p_user_id: userId,
    p_learner_id: approval.learnerId,
    p_summary_id: approval.summaryId,
  });
  if (error) return Response.json({ error: "The summary draft could not be approved." }, { status: 400 });
  return Response.json({ status: "approved" });
}
