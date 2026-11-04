import { createClient } from "@supabase/supabase-js";

const parentTokenPattern = /^[0-9a-f]{64}$/;

export async function authorizeParentRequest(
  request: Request,
  options: { requireSecret?: boolean } = {},
) {
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
    return {
      context: null,
      response: Response.json({ error: "Parent access is required." }, { status: 401 }),
    } as const;
  }

  if (options.requireSecret && !secretKey) {
    return {
      context: null,
      response: Response.json(
        { error: "This parent feature is not configured." },
        { status: 503 },
      ),
    } as const;
  }

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return {
      context: null,
      response: Response.json({ error: "Unauthorized." }, { status: 401 }),
    } as const;
  }

  const { data: parentAccess, error: parentAccessError } = await caller.rpc(
    "validate_parent_access_session",
    { p_token: parentToken },
  );
  if (parentAccessError || parentAccess !== true) {
    return {
      context: null,
      response: Response.json({ error: "Parent access has expired." }, { status: 403 }),
    } as const;
  }

  const admin = secretKey
    ? createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

  return {
    context: {
      caller,
      admin,
      parentToken,
      userId: userData.user.id,
    },
    response: null,
  } as const;
}

export async function parentOwnsLearner(
  context: NonNullable<Awaited<ReturnType<typeof authorizeParentRequest>>["context"]>,
  learnerId: string,
) {
  const client = context.admin ?? context.caller;
  const { data, error } = await client
    .from("learners")
    .select("id")
    .eq("id", learnerId)
    .eq("user_id", context.userId)
    .maybeSingle();

  return !error && Boolean(data);
}
