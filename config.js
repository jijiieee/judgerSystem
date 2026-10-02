const SUPABASE_URL = "https://rxebbshxohkqsqtqykcg.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4HqsRlbuzS860c5Qjcfk9g_mio92f9I";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      storage: window.localStorage,
      storageKey: "sc_auth_session_v3",
      persistSession: true,
      autoRefreshToken: true
    }
  }
);
