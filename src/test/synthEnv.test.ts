import { describe, it, expect } from "vitest";
import {
  requireSynthEnv,
  sanitizeDomainPrefix,
  resolveCognitoDomainPrefix,
  resolveAppCallbackUrl,
} from "../../amplify/synthEnv";

// The CreateUserPoolDomain "Domain" pattern — every derived prefix must satisfy it.
const VALID_PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_WORDS = /aws|amazon|cognito/;
const APP_ID = "d1mt6ip3ppwmko";

describe("resolveCognitoDomainPrefix", () => {
  it("uses the explicit COGNITO_DOMAIN_PREFIX over an app-id fallback", () => {
    expect(
      resolveCognitoDomainPrefix({ COGNITO_DOMAIN_PREFIX: "my-prefix", AWS_APP_ID: APP_ID })
    ).toBe("my-prefix");
  });

  it("returns the sandbox script default snitch-auth verbatim when provided explicitly", () => {
    expect(resolveCognitoDomainPrefix({ COGNITO_DOMAIN_PREFIX: "snitch-auth" })).toBe("snitch-auth");
  });

  it("trims the explicit value", () => {
    expect(resolveCognitoDomainPrefix({ COGNITO_DOMAIN_PREFIX: "  my-prefix  " })).toBe("my-prefix");
  });

  it("derives snitch-<branch>-<app-id> when both AWS_APP_ID and AWS_BRANCH are set", () => {
    expect(resolveCognitoDomainPrefix({ AWS_APP_ID: APP_ID, AWS_BRANCH: "main" })).toBe(
      `snitch-main-${APP_ID}`
    );
  });

  it("derives snitch-<app-id> when only AWS_APP_ID is set", () => {
    expect(resolveCognitoDomainPrefix({ AWS_APP_ID: APP_ID })).toBe(`snitch-${APP_ID}`);
  });

  it("throws when there is no explicit value and no AWS_APP_ID (sandbox without the var)", () => {
    expect(() => resolveCognitoDomainPrefix({})).toThrow(/COGNITO_DOMAIN_PREFIX is required/);
  });

  it("throws on a blank explicit value with no app-id to fall back to", () => {
    expect(() => resolveCognitoDomainPrefix({ COGNITO_DOMAIN_PREFIX: "   " })).toThrow(
      /COGNITO_DOMAIN_PREFIX is required/
    );
  });

  it("falls through a blank explicit value to the app-id derivation", () => {
    expect(resolveCognitoDomainPrefix({ COGNITO_DOMAIN_PREFIX: "", AWS_APP_ID: APP_ID })).toBe(
      `snitch-${APP_ID}`
    );
  });

  it("lets a value provided later override the fallback", () => {
    const derived = resolveCognitoDomainPrefix({ AWS_APP_ID: APP_ID, AWS_BRANCH: "main" });
    const overridden = resolveCognitoDomainPrefix({
      AWS_APP_ID: APP_ID,
      AWS_BRANCH: "main",
      COGNITO_DOMAIN_PREFIX: "chosen",
    });
    expect(derived).toBe(`snitch-main-${APP_ID}`);
    expect(overridden).toBe("chosen");
  });

  it("always produces a valid Cognito prefix from a real app-id", () => {
    expect(resolveCognitoDomainPrefix({ AWS_APP_ID: APP_ID, AWS_BRANCH: "main" })).toMatch(
      VALID_PREFIX
    );
  });

  it("neutralizes reserved substrings that appear inside the app-id", () => {
    const result = resolveCognitoDomainPrefix({ AWS_APP_ID: "dawscognito1", AWS_BRANCH: "amazonx" });
    expect(result).toMatch(VALID_PREFIX);
    expect(result).not.toMatch(RESERVED_WORDS);
  });
});

describe("sanitizeDomainPrefix", () => {
  it("lowercases the input", () => {
    expect(sanitizeDomainPrefix("Snitch-ABCDEF")).toBe("snitch-abcdef");
  });

  it("strips the reserved word aws", () => {
    expect(sanitizeDomainPrefix("snitch-dawsxyz")).toBe("snitch-dxyz");
  });

  it("strips the reserved words amazon and cognito", () => {
    expect(sanitizeDomainPrefix("snitch-cognito123")).toBe("snitch-123");
    expect(sanitizeDomainPrefix("snitch-amazon9")).toBe("snitch-9");
  });

  it("removes characters outside [a-z0-9-]", () => {
    expect(sanitizeDomainPrefix("snitch_d1@mt6")).toBe("snitchd1mt6");
  });

  it("trims leading and trailing hyphens", () => {
    expect(sanitizeDomainPrefix("-snitch-")).toBe("snitch");
  });

  it("clamps to 63 chars and re-trims an exposed trailing hyphen", () => {
    const result = sanitizeDomainPrefix("snitch-" + "a".repeat(80));
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result).toMatch(VALID_PREFIX);
  });

  it("keeps the snitch prefix when the rest is empty", () => {
    expect(sanitizeDomainPrefix("snitch-")).toBe("snitch");
  });
});

describe("resolveAppCallbackUrl", () => {
  it("uses the explicit APP_CALLBACK_URL over the Amplify default", () => {
    expect(
      resolveAppCallbackUrl({
        APP_CALLBACK_URL: "https://app.example.com",
        AWS_APP_ID: APP_ID,
        AWS_BRANCH: "main",
      })
    ).toBe("https://app.example.com");
  });

  it("trims the explicit value", () => {
    expect(resolveAppCallbackUrl({ APP_CALLBACK_URL: "  https://app.example.com  " })).toBe(
      "https://app.example.com"
    );
  });

  it("builds the Amplify default domain when both AWS_APP_ID and AWS_BRANCH are set", () => {
    expect(resolveAppCallbackUrl({ AWS_APP_ID: APP_ID, AWS_BRANCH: "main" })).toBe(
      `https://main.${APP_ID}.amplifyapp.com`
    );
  });

  it("needs both app-id and branch — app-id alone falls back to localhost", () => {
    expect(resolveAppCallbackUrl({ AWS_APP_ID: APP_ID })).toBe("http://localhost:5173");
  });

  it("needs both app-id and branch — branch alone falls back to localhost", () => {
    expect(resolveAppCallbackUrl({ AWS_BRANCH: "main" })).toBe("http://localhost:5173");
  });

  it("falls back to localhost for a bare sandbox environment", () => {
    expect(resolveAppCallbackUrl({})).toBe("http://localhost:5173");
  });

  it("falls through a blank explicit value to the derived domain", () => {
    expect(
      resolveAppCallbackUrl({ APP_CALLBACK_URL: "", AWS_APP_ID: APP_ID, AWS_BRANCH: "main" })
    ).toBe(`https://main.${APP_ID}.amplifyapp.com`);
  });

  it("never appends a trailing slash (notify.ts concatenates #/approve-requests)", () => {
    expect(resolveAppCallbackUrl({ AWS_APP_ID: APP_ID, AWS_BRANCH: "main" }).endsWith("/")).toBe(
      false
    );
  });
});

describe("requireSynthEnv", () => {
  it("returns the value when present", () => {
    expect(requireSynthEnv({ IDC_SAML_METADATA_URL: "https://idp/metadata" }, "IDC_SAML_METADATA_URL")).toBe(
      "https://idp/metadata"
    );
  });

  it("returns the fallback when the var is missing", () => {
    expect(requireSynthEnv({}, "X", "fallback")).toBe("fallback");
  });

  it("throws the exact message when both the var and fallback are missing", () => {
    expect(() => requireSynthEnv({}, "X")).toThrow(
      "Environment variable X is required for synth-time Cognito config."
    );
  });

  it("throws for an empty string with no fallback", () => {
    expect(() => requireSynthEnv({ X: "" }, "X")).toThrow();
  });
});
