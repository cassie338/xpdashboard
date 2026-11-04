import { createClient } from "@supabase/supabase-js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const parentTokenPattern = /^[0-9a-f]{64}$/;

function attachmentFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 180) || "assessment-report";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sourceId: string }> },
) {
  const { sourceId } = await params;
  if (!uuidPattern.test(sourceId)) return new Response(null, { status: 404 });

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
      { error: "Assessment downloads are not configured." },
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

  const { data: sources, error: sourceError } = await caller.rpc(
    "get_assessment_source_download",
    { p_parent_token: parentToken, p_source_id: sourceId },
  );
  const source = Array.isArray(sources) ? sources[0] : null;
  if (sourceError || !source) return new Response(null, { status: 404 });

  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: file, error: downloadError } = await admin.storage
    .from("assessment-sources")
    .download(source.storage_path);
  if (downloadError || !file) return new Response(null, { status: 404 });

  return new Response(file, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": `attachment; filename="${attachmentFilename(source.original_filename)}"`,
      "Content-Type": source.content_type,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
