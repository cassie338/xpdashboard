import { z } from "zod";

import { authorizeParentRequest, parentOwnsLearner } from "@/lib/parent-api";

const createRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observation"),
      learnerId: z.string().uuid(),
      observationDate: z.string().date(),
      subject: z.string().trim().max(120),
      observationText: z.string().trim().min(1).max(4000),
      relatedSkill: z.string().trim().max(240),
      assessmentId: z.string().uuid().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("priority"),
      learnerId: z.string().uuid(),
      title: z.string().trim().min(1).max(240),
      subject: z.string().trim().max(120),
      notes: z.string().trim().max(3000),
    })
    .strict(),
]);

const priorityPatchSchema = z
  .object({
    learnerId: z.string().uuid(),
    priorityId: z.string().uuid(),
    title: z.string().trim().min(1).max(240).optional(),
    subject: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(3000).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export async function POST(request: Request) {
  const authorization = await authorizeParentRequest(request, { requireSecret: true });
  if (!authorization.context) return authorization.response;

  let record: z.infer<typeof createRecordSchema>;
  try {
    record = createRecordSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Enter valid learner profile details." }, { status: 400 });
  }
  if (!(await parentOwnsLearner(authorization.context, record.learnerId))) {
    return Response.json({ error: "Learner not found." }, { status: 404 });
  }

  const { admin, userId } = authorization.context;
  if (!admin) return Response.json({ error: "Profile editing is not configured." }, { status: 503 });

  if (record.kind === "observation") {
    if (record.assessmentId) {
      const { data: assessment } = await admin
        .from("learner_assessments")
        .select("id")
        .eq("id", record.assessmentId)
        .eq("learner_id", record.learnerId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!assessment) return Response.json({ error: "Assessment not found." }, { status: 404 });
    }
    const { data, error } = await admin
      .from("learner_observations")
      .insert({
        user_id: userId,
        learner_id: record.learnerId,
        observation_date: record.observationDate,
        subject: record.subject,
        observation_text: record.observationText,
        related_skill: record.relatedSkill,
        assessment_id: record.assessmentId,
      })
      .select("*")
      .single();
    if (error) return Response.json({ error: "The observation could not be saved." }, { status: 500 });
    return Response.json({ observation: data });
  }

  const { data, error } = await admin
    .from("learner_priorities")
    .insert({
      user_id: userId,
      learner_id: record.learnerId,
      title: record.title,
      subject: record.subject,
      notes: record.notes,
    })
    .select("*")
    .single();
  if (error) return Response.json({ error: "The priority could not be saved." }, { status: 500 });
  return Response.json({ priority: data });
}

export async function PATCH(request: Request) {
  const authorization = await authorizeParentRequest(request, { requireSecret: true });
  if (!authorization.context) return authorization.response;

  let patch: z.infer<typeof priorityPatchSchema>;
  try {
    patch = priorityPatchSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Enter valid priority details." }, { status: 400 });
  }
  if (!(await parentOwnsLearner(authorization.context, patch.learnerId))) {
    return Response.json({ error: "Learner not found." }, { status: 404 });
  }

  const { admin, userId } = authorization.context;
  if (!admin) return Response.json({ error: "Profile editing is not configured." }, { status: 503 });
  const changes = {
    updated_at: new Date().toISOString(),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  };
  if (Object.keys(changes).length === 1) {
    return Response.json({ error: "No priority changes were provided." }, { status: 400 });
  }
  const { data, error } = await admin
    .from("learner_priorities")
    .update(changes)
    .eq("id", patch.priorityId)
    .eq("learner_id", patch.learnerId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error || !data) return Response.json({ error: "Priority not found." }, { status: 404 });
  return Response.json({ priority: data });
}
