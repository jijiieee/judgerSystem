import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // 1. Who is calling?
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) {
      return json({ error: "You are not signed in." }, 401);
    }

    //admin check
    const { data: caller } = await admin
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .single();
    if (caller?.role !== "admin") {
      return json({ error: "Only admins can create judge accounts." }, 403);
    }

    //input validation
    const body = await req.json();
    const event_id = String(body.event_id ?? "");
    const display_name = String(body.display_name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    if (!event_id || !display_name || !email || !password) {
      return json({ error: "Event, name, email and password are required." }, 400);
    }
    if (password.length < 6) {
      return json({ error: "Password must be at least 6 characters." }, 400);
    }

    const { data: event } = await admin
      .from("events")
      .select("id")
      .eq("id", event_id)
      .maybeSingle();
    if (!event) return json({ error: "Event not found." }, 404);

    // create auth user + profile + event assignment
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError || !created.user) {
      return json({ error: createError?.message ?? "Could not create the user." }, 400);
    }
    const judgeId = created.user.id;

    const { error: profileError } = await admin.from("profiles").insert({
      id: judgeId,
      display_name,
      email,
      role: "judge",
    });
    if (profileError) {
      await admin.auth.admin.deleteUser(judgeId); // safe: no scores exist yet
      return json({ error: profileError.message }, 400);
    }

    const { error: assignError } = await admin.from("event_judges").insert({
      event_id,
      judge_id: judgeId,
      active: true,
    });
    if (assignError) {
      await admin.auth.admin.deleteUser(judgeId); // profile cascades; no scores yet
      return json({ error: assignError.message }, 400);
    }

    return json({ ok: true, judge_id: judgeId });
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
