import { z } from "zod";

import { assessmentSkillStatuses } from "@/lib/learner-profile-ai";
import { authorizeParentRequest } from "@/lib/parent-api";

const reviewSchema = z
  .object({
    assessmentId: z.string().uuid(),
    extractionId: z.string().uuid(),
    findings: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            correction: z.string().trim().max(3000),
            statusOverride: z.enum(assessmentSkillStatuses).nullable(),
          })
          .strict(),
      )
      .max(300),
  })
  .strict();

export async function POST(request: Request) {
  const authorization = await authorizeParentRequest(request, { requireSecret: true });
  if (!authorization.context) return authorization.response;

  let review: z.infer<typeof reviewSchema>;
  try {
    review = reviewSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Enter valid assessment review details." }, { status: 400 });
  }

  const { admin, userId } = authorization.context;
  if (!admin) return Response.json({ error: "Assessment review is not configured." }, { status: 503 });
  const { data: assessment, error: assessmentError } = await admin
    .from("learner_assessments")
    .select("id")
    .eq("id", review.assessmentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (assessmentError || !assessment) {
    return Response.json({ error: "Assessment not found." }, { status: 404 });
  }

  const { error } = await admin.rpc("approve_assessment_review", {
    p_assessment_id: review.assessmentId,
    p_extraction_id: review.extractionId,
    p_reviews: review.findings.map((finding) => ({
      id: finding.id,
      correction: finding.correction,
      statusOverride: finding.statusOverride ?? "",
    })),
  });
  if (error) {
    return Response.json(
      { error: "The assessment review could not be approved. Check every finding and try again." },
      { status: 400 },
    );
  }
  return Response.json({ status: "approved" });
}
