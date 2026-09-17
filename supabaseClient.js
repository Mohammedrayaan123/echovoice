// supabaseClient.js — server-side Supabase client for audio logging (see
// server.js's /save-audio endpoint). Lives at the project root, NOT under
// public/, so it's never web-reachable and the key can never leak to the
// browser — everything the client needs goes through /save-audio instead.
//
// Uses the SECRET key (not the publishable/anon key): the audio-logs bucket
// has no Storage RLS policies configured, so the publishable key can't upload
// to it without extra policy setup. The secret key bypasses that and is safe
// to use here specifically BECAUSE this module never runs in the browser.
//
// SUPABASE_URL/SUPABASE_SECRET_KEY are optional: audio logging is best-effort,
// so if they're not set (e.g. before the Supabase project is created, or in
// an environment that doesn't need remote logging), this exports null instead
// of throwing — createClient() itself throws synchronously on a missing URL,
// which would otherwise crash the whole server at startup over an optional feature.
import { createClient } from "@supabase/supabase-js";

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
    : null;

export default supabase;
