import { createClient } from "@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });

function getSecretKey(): string {
  // Supabase's current Edge Runtime injects named secret keys. Keep the
  // legacy service-role variable as a compatibility fallback for older projects.
  const secretMapRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretMapRaw) {
    try {
      const secretMap = JSON.parse(secretMapRaw) as Record<string, unknown>;
      const defaultKey = secretMap.default;
      if (typeof defaultKey === "string" && defaultKey.trim()) return defaultKey.trim();
    } catch {
      throw new Error("Supabase secret-key configuration is invalid.");
    }
  }

  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy?.trim()) return legacy.trim();
  throw new Error("No server-side Supabase secret key is configured.");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return json(405, { error: "Use GET to check availability or POST to delete the signed-in account.", code: "method_not_allowed" });
  }

  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return json(401, { error: "A valid signed-in session is required.", code: "unauthorized" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) {
    return json(500, { error: "The account-deletion service is not configured.", code: "server_configuration_error" });
  }

  let secretKey: string;
  try {
    secretKey = getSecretKey();
  } catch (error) {
    console.error("Account deletion secret configuration error:", error);
    return json(500, { error: "The account-deletion service is not configured.", code: "server_configuration_error" });
  }

  const admin = createClient(supabaseUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  // Identity comes only from the verified bearer token. The request body is
  // intentionally ignored; a caller cannot submit another user's ID.
  const { data: authData, error: authError } = await admin.auth.getUser(match[1]);
  const user = authData?.user;
  if (authError || !user?.id) {
    return json(401, { error: "Your sign-in session could not be verified. Sign in again and retry.", code: "invalid_session" });
  }

  // The client uses this authenticated read-only response to avoid showing
  // an active deletion action when the function has not been deployed.
  if (request.method === "GET") {
    return json(200, { ready: true });
  }

  // Require a recent interactive sign-in before performing an irreversible
  // account deletion. Token refresh alone does not satisfy this requirement.
  const signedInAt = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : Number.NaN;
  const now = Date.now();
  const recentWindowMs = 10 * 60 * 1000;
  if (!Number.isFinite(signedInAt) || signedInAt > now + 60_000 || now - signedInAt > recentWindowMs) {
    return json(403, {
      error: "Sign in again immediately before deleting your account.",
      code: "reauthentication_required",
    });
  }

  const { error: deletionError } = await admin.auth.admin.deleteUser(user.id);
  if (deletionError) {
    // Do not return provider internals or a service credential to the browser.
    console.error("Supabase account deletion failed:", deletionError.message);
    return json(500, {
      error: "Supabase could not complete account deletion. No local data was cleared.",
      code: "account_deletion_failed",
    });
  }

  return json(200, { success: true });
});
