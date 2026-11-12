import { ACTIVE_COUNTIES, SCHEDULED_JOBS } from "@lienradar/shared";
import { jobCountiesFromResourceKeys } from "@/lib/countyLabel";

const BY_KEY = new Map(SCHEDULED_JOBS.map((j) => [j.key, j]));

/** Counties a scheduled job is relevant to (from shared job → resourceKeys map). */
export function countiesForJobKey(jobKey: string): string[] {
  const def = BY_KEY.get(jobKey);
  return jobCountiesFromResourceKeys(def?.resourceKeys, ACTIVE_COUNTIES);
}
