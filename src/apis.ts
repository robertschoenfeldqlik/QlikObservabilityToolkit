export const TMC_API_VERSION_DEFAULT = "2021-03";

export const TMC_REGIONS = {
  eu: "https://api.eu.cloud.talend.com",
  us: "https://api.us.cloud.talend.com",
  ap: "https://api.ap.cloud.talend.com",
  au: "https://api.au.cloud.talend.com",
  "us-west": "https://api.us-west.cloud.talend.com",
} as const;

export type TmcRegion = keyof typeof TMC_REGIONS;

export const TMC_APIS = [
  "orchestration",
  "dataset",
  "connections",
  "audit-logs",
  "observability-metrics",
  "execution-logs",
  "execution-history-search",
  "identities-management",
  "service-accounts",
  "workspace-permissions",
  "sso-role-mapping",
  "ip-allowlist",
  "oauth",
  "scim-v2",
  "seats-and-subscription",
  "sharing",
  "processing",
  "crawler",
  "dynamic-engine",
  "dynamic-engine-environments",
] as const;

export type TmcApi = (typeof TMC_APIS)[number];

export function specUrl(api: TmcApi, version = TMC_API_VERSION_DEFAULT): string {
  return `https://talend.qlik.dev/apis/${api}/${version}/openapi30.json`;
}
