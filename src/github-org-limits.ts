// A complete membership snapshot must fit both D1 and the OAuth claim.
export const MAX_GITHUB_ORG_PAGES = 4;
export const MAX_GITHUB_ORGS = 300;
export const MAX_GITHUB_ORG_RESPONSE_BYTES = 256 * 1024;
export const MAX_GITHUB_ORGS_JSON_BYTES = 8 * 1024;
export const MAX_GITHUB_ORG_FETCH_MS = 5_000;

export function fitsGithubOrgsBudget(orgs: string[]): boolean {
  return (
    orgs.length <= MAX_GITHUB_ORGS &&
    new TextEncoder().encode(JSON.stringify(orgs)).byteLength <=
      MAX_GITHUB_ORGS_JSON_BYTES
  );
}
