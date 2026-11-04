import { createClient } from "@supabase/supabase-js";

const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const parentTokenPattern = /^[0-9a-f]{64}$/;

const reportTypes = {
  "application/pdf": { extensions: [".pdf"], signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  "image/jpeg": { extensions: [".jpg", ".jpeg"], signature: [0xff, 0xd8, 0xff] },
  "image/png": {
    extensions: [".png"],
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
} as const;

type ReportType = keyof typeof reportTypes;

function safeFilename(filename: string) {
  const cleaned = filename
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  return cleaned || "assessment-report";
}

function validAssessmentDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value) && value <= new Date().toISOString().slice(0, 10);
}

function hasSignature(bytes: Uint8Array, signature: readonly number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function hexDigest(buffer: ArrayBuffer) {
  return crypto.subtle.digest("SHA-256", buffer).then((digest) =>
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );
}

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const accessToken = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : null;
  const parentToken = request.headers.get("x-parent-access-token");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secretKey =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (
    !accessToken ||
    !parentToken ||
    !parentTokenPattern.test(parentToken) ||
    !supabaseUrl ||
    !publishableKey
  ) {
    return Response.json({ error: "Parent access is required." }, { status: 401 });
  }
  if (!secretKey) {
    return Response.json(
      { error: "Assessment uploads are not configured." },
      { status: 503 },
    );
  }

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { data: parentAccess, error: parentAccessError } = await caller.rpc(
    "validate_parent_access_session",
    { p_token: parentToken },
  );
  if (parentAccessError || parentAccess !== true) {
    return Response.json({ error: "Parent access has expired." }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid upload." }, { status: 400 });
  }

  const learnerId = String(formData.get("learnerId") ?? "");
  const sourceLabel = String(formData.get("sourceLabel") ?? "").trim();
  const assessmentDateValue = String(formData.get("assessmentDate") ?? "").trim();
  const uploaded = formData.get("report");
  if (!uuidPattern.test(learnerId)) {
    return Response.json({ error: "Choose a valid learner." }, { status: 400 });
  }
  if (sourceLabel.length < 1 || sourceLabel.length > 120) {
    return Response.json({ error: "Enter the report source." }, { status: 400 });
  }
  if (assessmentDateValue && !validAssessmentDate(assessmentDateValue)) {
    return Response.json({ error: "Enter a valid report date." }, { status: 400 });
  }
  if (!(uploaded instanceof File) || uploaded.size === 0) {
    return Response.json({ error: "Choose a report file." }, { status: 400 });
  }
  if (uploaded.size > MAX_REPORT_BYTES) {
    return Response.json({ error: "The report must be 10 MB or smaller." }, { status: 400 });
  }

  const reportType = uploaded.type.toLowerCase() as ReportType;
  const typeRule = reportTypes[reportType];
  const lowerFilename = uploaded.name.toLowerCase();
  if (!typeRule || !typeRule.extensions.some((extension) => lowerFilename.endsWith(extension))) {
    return Response.json(
      { error: "Choose a PDF, JPEG, or PNG assessment report." },
      { status: 400 },
    );
  }

  const buffer = await uploaded.arrayBuffer();
  if (!hasSignature(new Uint8Array(buffer), typeRule.signature)) {
    return Response.json(
      { error: "The file contents do not match its report type." },
      { status: 400 },
    );
  }

  const { data: learner, error: learnerError } = await caller
    .from("learners")
    .select("id")
    .eq("id", learnerId)
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (learnerError || !learner) {
    return Response.json({ error: "Learner not found." }, { status: 404 });
  }

  const sourceId = crypto.randomUUID();
  const checksum = await hexDigest(buffer);
  const originalFilename = uploaded.name.trim().slice(0, 255);
  const storagePath = `${userData.user.id}/${learnerId}/${sourceId}/${safeFilename(originalFilename)}`;
  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const uploadResult = await admin.storage
    .from("assessment-sources")
    .upload(storagePath, buffer, { contentType: reportType, upsert: false });
  if (uploadResult.error) {
    return Response.json({ error: "The report could not be stored." }, { status: 500 });
  }

  const { data: registration, error: registerError } = await caller.rpc("register_learner_assessment", {
    p_parent_token: parentToken,
    p_source_id: sourceId,
    p_assessment_id: crypto.randomUUID(),
    p_learner_id: learnerId,
    p_source_label: sourceLabel,
    p_assessment_date: assessmentDateValue || null,
    p_original_filename: originalFilename,
    p_storage_path: storagePath,
    p_content_type: reportType,
    p_byte_size: uploaded.size,
    p_file_sha256: checksum,
  });
  if (registerError) {
    const { data: matchingSources, error: reconciliationError } = await caller.rpc(
      "find_assessment_source_by_checksum",
      {
        p_parent_token: parentToken,
        p_learner_id: learnerId,
        p_file_sha256: checksum,
      },
    );
    const matchingSource = Array.isArray(matchingSources)
      ? matchingSources[0]
      : null;
    if (matchingSource?.id === sourceId) {
      return Response.json({
        source: {
          id: sourceId,
          learnerId,
          sourceLabel,
          assessmentDate: assessmentDateValue || null,
          originalFilename,
          contentType: reportType,
          byteSize: uploaded.size,
          uploadedAt: new Date().toISOString(),
        },
      });
    }
    if (matchingSource) {
      await admin.storage.from("assessment-sources").remove([storagePath]);
      return Response.json(
        { error: "This report has already been uploaded for the learner." },
        { status: 409 },
      );
    }
    if (reconciliationError) {
      return Response.json(
        {
          error:
            "The report was stored, but registration could not be confirmed. Retry later.",
        },
        { status: 503 },
      );
    }
    await admin.storage.from("assessment-sources").remove([storagePath]);
    return Response.json(
      { error: "The stored report could not be registered." },
      { status: 400 },
    );
  }

  return Response.json({
    assessmentId: Array.isArray(registration) ? registration[0]?.assessment_id : null,
    source: {
      id: sourceId,
      learnerId,
      sourceLabel,
      assessmentDate: assessmentDateValue || null,
      originalFilename,
      contentType: reportType,
      byteSize: uploaded.size,
      uploadedAt: new Date().toISOString(),
    },
  });
}
