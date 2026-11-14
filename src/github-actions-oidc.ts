import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://token.actions.githubusercontent.com";
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));

export async function authorizePreviewCallbacks(token: string) {
  const audience =
    "https://auth.fossbilling.net/integrations/extensions-preview-callbacks";
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "repository_id", "workflow_ref"]
  });
  return (
    payload.repository_id === "557829655" &&
    payload.workflow_ref ===
      "FOSSBilling/extensions/.github/workflows/preview-auth.yml@refs/heads/main"
  );
}
