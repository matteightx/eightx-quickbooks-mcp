declare module "intuit-oauth" {
  // Minimal shim — intuit-oauth ships no types. We only use a tiny surface.
  export default class OAuthClient {
    constructor(opts: {
      clientId: string;
      clientSecret: string;
      environment: "sandbox" | "production";
      redirectUri: string;
    });
    static scopes: { Accounting: string; Payment: string; OpenId: string };
    authorizeUri(opts: { scope: string[]; state: string }): string;
    createToken(url: string): Promise<{ getJson(): unknown; token?: any }>;
    refreshUsingToken(refreshToken: string): Promise<{ getJson(): unknown }>;
  }
}
