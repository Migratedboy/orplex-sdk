// Optional runtime modules the tool layer probes with dynamic import().
// Declared here so the SDK type-checks and builds WITHOUT forcing every
// consumer to install Playwright or a Sentry SDK.
declare module "playwright";
declare module "@sentry/nextjs";
declare module "@modelcontextprotocol/client" {
  export type FetchLike = (url: string | URL, init?: any) => Promise<Response>;
}
