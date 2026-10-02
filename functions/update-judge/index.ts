// Supabase Edge Function: update-judge
// Lets a signed-in ADMIN change a judge's name, login email and/or password.
// Runs server-side so the service_role key never reaches the browser.
//
// Deploy:  supabase functions deploy update-judge
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)

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

    // 2. Are they an admin?
    const { data: caller } = await admin
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .single();
    if (caller?.role !== "admin") {
      return json({ error: "Only admins can edit judge accounts." }, 403);
    }

    // 3. Validate input
    const body = await req.json();
    const judge_id = String(body.judge_id ?? "");
    const display_name = body.display_name === undefined ? undefined : String(body.display_name).trim();
    const email = body.email === undefined ? undefined : String(body.email).trim().toLowerCase();
    const password = body.password ? String(body.password) : undefined;

    if (!judge_id) return json({ error: "Judge is required." }, 400);
    if (display_name !== undefined && !display_name) {
      return json({ error: "Name can't be empty." }, 400);
    }
    if (email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: "Enter a valid email address." }, 400);
    }
    if (password !== undefined && password.length < 6) {
      return json({ error: "Password must be at least 6 characters." }, 400);
    }

    // 4. Only judge accounts can be edited here
    const { data: target } = await admin
      .from("profiles")
      .select("id, role, email, display_name")
      .eq("id", judge_id)
      .maybeSingle();
    if (!target || target.role !== "judge") {
      return json({ error: "Judge account not found." }, 404);
    }

    // 5. Login credentials (auth.users). Done first: if the email is already
    //    taken this fails and nothing else has changed.
    const emailChanged = email !== undefined && email !== (target.email ?? "").toLowerCase();
    const authChanges: Record<string, unknown> = {};
    if (emailChanged) { authChanges.email = email; authChanges.email_confirm = true; }
    if (password !== undefined) authChanges.password = password;

    if (Object.keys(authChanges).length) {
      const { error: authError } = await admin.auth.admin.updateUserById(judge_id, authChanges);
      if (authError) return json({ error: authError.message }, 400);
    }

    // 6. Profile (name + email shown in the admin pages)
    const profileChanges: Record<string, unknown> = {};
    if (display_name !== undefined) profileChanges.display_name = display_name;
    if (email !== undefined) profileChanges.email = email;

    if (Object.keys(profileChanges).length) {
      const { error: profileError } = await admin
        .from("profiles").update(profileChanges).eq("id", judge_id);
      if (profileError) {
        if (emailChanged && target.email) {
          // keep login email and profile email in sync
          await admin.auth.admin.updateUserById(judge_id, { email: target.email, email_confirm: true });
        }
        return json({ error: profileError.message }, 400);
      }
    }

    return json({ ok: true });
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
