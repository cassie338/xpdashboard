import { z } from "zod";

import { extractAssessmentFile, getAiConfiguration } from "@/lib/learner-profile-ai";
import { authorizeParentRequest } from "@/lib/parent-api";

const requestSchema = z.object({ assessmentId: z.string().uuid() }).strict();

export async function POST(request: Request) {
  const authorization = await authorizeParentRequest(request, { requireSecret: true });
  if (!authorization.context) return authorization.response;

  let assessmentId: string;
  try {
    assessmentId = requestSchema.parse(await request.json()).assessmentId;
  } catch {
    return Response.json({ error: "Choose a valid assessment." }, { status: 400 });
  }

  const configuration = getAiConfiguration();
  if (!configuration) {
    return Response.json(
      { error: "Assessment processing is unavailable because the AI provider is not configured." },
      { status: 503 },
    );
  }

  const { admin, userId } = authorization.context;
  if (!admin) {
    return Response.json({ error: "Assessment processing is not configured." }, { status: 503 });
  }

  const { data: assessment, error: assessmentError } = await admin
    .from("learner_assessments")
    .select("id, learner_id, source_file_id, processing_status, updated_at")
    .eq("id", assessmentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (assessmentError || !assessment) {
    return Response.json({ error: "Assessment not found." }, { status: 404 });
  }
  const staleProcessing =
    assessment.processing_status === "processing" &&
    Date.now() - new Date(assessment.updated_at).valueOf() > 15 * 60 * 1000;
  if (!["uploaded", "failed"].includes(assessment.processing_status) && !staleProcessing) {
    return Response.json(
      { error: "This assessment is already being processed or reviewed." },
      { status: 409 },
    );
  }

  const { data: source, error: sourceError } = await admin
    .from("assessment_source_files")
    .select("storage_path, original_filename, content_type")
    .eq("id", assessment.source_file_id)
    .eq("user_id", userId)
    .eq("learner_id", assessment.learner_id)
    .maybeSingle();
  if (sourceError || !source) {
    return Response.json({ error: "The assessment source file is unavailable." }, { status: 404 });
  }

  const { data: attemptId, error: beginError } = await admin.rpc("begin_assessment_processing", {
    p_assessment_id: assessmentId,
    p_provider_name: "OpenAI",
    p_model_name: configuration.model,
  });
  if (beginError || typeof attemptId !== "string") {
    return Response.json({ error: "Assessment processing could not be started." }, { status: 409 });
  }

  try {
    const { data: file, error: downloadError } = await admin.storage
      .from("assessment-sources")
      .download(source.storage_path);
    if (downloadError || !file) throw new Error("The source file could not be read.");

    const result = await extractAssessmentFile({
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: source.content_type,
      filename: source.original_filename,
    });
    const { error: persistError } = await admin.rpc("record_assessment_processing_success", {
      p_assessment_id: assessmentId,
      p_attempt_id: attemptId,
      p_provider_name: result.providerName,
      p_model_name: result.modelName,
      p_extraction: result.extraction,
      p_findings: result.extraction.findings,
    });
    if (persistError) throw new Error("The validated assessment result could not be stored.");

    return Response.json({ status: "ready_for_review" });
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message : "Assessment processing failed.";
    const { error: failureError } = await admin.rpc("record_assessment_processing_failure", {
      p_assessment_id: assessmentId,
      p_attempt_id: attemptId,
      p_provider_name: "OpenAI",
      p_model_name: configuration.model,
      p_error_message: safeMessage,
    });
    if (failureError) {
      console.error("Assessment processing failure state could not be recorded.", failureError.message);
    }
    return Response.json(
      { error: "The assessment could not be processed. You can retry without uploading it again." },
      { status: 502 },
    );
  }
}
