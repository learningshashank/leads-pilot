import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Placeholder scrape endpoints.
 *
 * DATA HONESTY: these do NOT invent leads. Until real Hunter.io / Apollo.io /
 * People Data Labs credentials are wired in, every run records a genuine
 * scrape_jobs row with status="failed", result_count=0 and an error message
 * explaining exactly which credential is missing. No rows are written to
 * `leads` or `companies`.
 */

type LogLine = { at: string; level: "info" | "error"; message: string };

const now = () => new Date().toISOString();

async function orgIdFor(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("users")
    .select("org_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.org_id) throw new Error("No organization for this user.");
  return data.org_id as string;
}

async function runJob(
  supabase: any,
  orgId: string,
  jobType: string,
  filters: Record<string, unknown>,
  apiUsed: string,
  envKey: string,
) {
  const logs: LogLine[] = [
    { at: now(), level: "info", message: `Job accepted (${jobType}).` },
    { at: now(), level: "info", message: `Filters: ${JSON.stringify(filters)}` },
  ];

  const { data: job, error } = await supabase
    .from("scrape_jobs")
    .insert({
      org_id: orgId,
      job_type: jobType,
      filters,
      api_used: apiUsed,
      status: "running",
      result_count: 0,
      log_lines: logs,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const hasKey = Boolean(process.env[envKey]);
  logs.push({
    at: now(),
    level: hasKey ? "info" : "error",
    message: hasKey
      ? `${envKey} is present, but the ${apiUsed} client is not implemented yet.`
      : `${envKey} is not configured in this project.`,
  });
  logs.push({
    at: now(),
    level: "error",
    message: "No records fetched. Nothing was written to leads or companies.",
  });

  const errorMessage = hasKey
    ? `${apiUsed} integration is not wired up yet — no request was sent.`
    : `${envKey} is missing. Add it in Settings → API keys before running this job.`;

  await supabase
    .from("scrape_jobs")
    .update({
      status: "failed",
      result_count: 0,
      error_message: errorMessage,
      log_lines: logs,
      completed_at: now(),
    })
    .eq("id", job.id);

  return { jobId: job.id as string, status: "failed" as const, resultCount: 0, errorMessage };
}

export const runDomainExtract = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ domain: z.string().min(3) }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await orgIdFor(context.supabase, context.userId);
    const domain = data.domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    return runJob(
      context.supabase,
      orgId,
      "domain_extract",
      { domain },
      "hunter.io",
      "HUNTER_API_KEY",
    );
  });

export const runSearchGenerate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        title: z.string().optional().default(""),
        industry: z.string().optional().default(""),
        seniority: z.string().optional().default(""),
        location: z.string().optional().default(""),
        provider: z.enum(["apollo", "pdl"]).default("apollo"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await orgIdFor(context.supabase, context.userId);
    const { provider, ...filters } = data;
    return runJob(
      context.supabase,
      orgId,
      "search_generate",
      filters,
      provider === "apollo" ? "apollo.io" : "peopledatalabs",
      provider === "apollo" ? "APOLLO_API_KEY" : "PDL_API_KEY",
    );
  });

/** Reports only whether a credential is present — never its value. */
export const getApiKeyStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const keys = ["HUNTER_API_KEY", "APOLLO_API_KEY", "PDL_API_KEY", "BOUNCER_API_KEY"];
    return keys.map((name) => ({ name, configured: Boolean(process.env[name]) }));
  });
