/**
 * Tenancy governance: which repos/orgs is this deployment authorized to serve, and
 * how much can any one owner consume. A Mayfly deployment runs jobs in the deployer's
 * OWN AWS account, so an App installed too broadly (or on an unexpected repo) must not
 * silently spin up MicroVMs on their bill.
 */

export interface AllowPolicy {
  /** org/user logins whose repos are served (case-insensitive). */
  allowedOwners: string[];
  /** exact `owner/repo` entries served (case-insensitive). */
  allowedRepos: string[];
  /** escape hatch: serve everything the App is installed on (personal all-repos setups). */
  allowAll: boolean;
}

const lc = (s: string): string => s.toLowerCase();

/**
 * True if this deployment is authorized to run jobs for owner/repo. Fail-closed:
 * with no owners/repos configured and allowAll=false, nothing is served.
 */
export function isAllowed(owner: string, repo: string, policy: AllowPolicy): boolean {
  const repoKey = lc(`${owner}/${repo}`);
  if (policy.allowedRepos.some((r) => lc(r) === repoKey)) return true;
  if (policy.allowedOwners.some((o) => lc(o) === lc(owner))) return true;
  return policy.allowAll;
}
