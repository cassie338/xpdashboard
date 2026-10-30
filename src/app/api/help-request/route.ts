import { createClient } from "@supabase/supabase-js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!token || !supabaseUrl || !supabaseKey) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const taskId = typeof body === "object" && body !== null && "taskId" in body ? (body as { taskId?: unknown }).taskId : null;
  if (typeof taskId !== "string" || !uuidPattern.test(taskId)) {
    return Response.json({ error: "A valid task is required." }, { status: 400 });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { data: helpRequestId, error: helpError } = await supabase.rpc("request_task_help", { p_task_id: taskId });
  if (helpError) {
    return Response.json({ error: helpError.message }, { status: 400 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = userData.user.email;
  if (!resendKey || !from || !to) {
    return Response.json({ helpRequestId, emailed: false });
  }

  const { data: task } = await supabase.from("tasks").select("name, learner_id").eq("id", taskId).single();
  const { data: learner } = task ? await supabase.from("learners").select("display_name").eq("id", task.learner_id).single() : { data: null };
  const learnerName = learner?.display_name ?? "Your learner";
  const taskName = task?.name ?? "their current task";

  try {
    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `${learnerName} requested help`,
        text: `${learnerName} asked for help with: ${taskName}\n\nOpen XP Dashboard and switch to Parent view to respond.`,
      }),
    });
    return Response.json({ helpRequestId, emailed: emailResponse.ok });
  } catch {
    return Response.json({ helpRequestId, emailed: false });
  }
}
