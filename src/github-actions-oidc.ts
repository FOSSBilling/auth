import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://token.actions.githubusercontent.com";
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));

export async function verifyGitHubActionsToken(
  token: string,
  audience: string
) {
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "repository_id", "workflow_ref"]
  });
  return payload;
}
