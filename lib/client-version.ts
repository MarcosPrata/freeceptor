import packageJson from "../package.json";

type FreeceptorPackage = {
  version: string;
  "client-version"?: string;
};

const pkg = packageJson as FreeceptorPackage;

/** Versão do agent que este server espera. Vem de `package.json#client-version`. */
export const EXPECTED_CLIENT_VERSION = pkg["client-version"]?.trim() || pkg.version;

export const FREECEPTOR_CLIENT_IMAGE = `mhpjunior/freeceptor-client:${EXPECTED_CLIENT_VERSION}`;

export function isCompatibleClientVersion(version?: string | null): boolean {
  if (!version?.trim()) return false;
  return version.trim() === EXPECTED_CLIENT_VERSION;
}
