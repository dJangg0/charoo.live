import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { assertCloudflareDeployBranch } from "../celld/scripts/cloudflare-deploy-branch";

describe("Cloudflare deployment branch guard", () => {
  it("checks the target branch before either publish script builds or deploys", () => {
    const { scripts } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const guard = "tsx celld/scripts/cloudflare-deploy-guard.ts";

    expect(scripts["deploy:cloudflare"].split(" && ")[0]).toBe(
      `${guard} production`,
    );
    expect(scripts["deploy:cloudflare:staging"].split(" && ")[0]).toBe(
      `${guard} staging`,
    );
  });

  it("allows production deployment from main", () => {
    expect(() =>
      assertCloudflareDeployBranch("production", "main"),
    ).not.toThrow();
  });

  it("blocks production deployment from staging and feature branches", () => {
    expect(() => assertCloudflareDeployBranch("production", "staging")).toThrow(
      'Refusing production Cloudflare deployment from branch "staging"',
    );
    expect(() =>
      assertCloudflareDeployBranch("production", "feature/example"),
    ).toThrow(
      'Refusing production Cloudflare deployment from branch "feature/example"',
    );
  });

  it("allows staging deployment from staging", () => {
    expect(() =>
      assertCloudflareDeployBranch("staging", "staging"),
    ).not.toThrow();
  });

  it("blocks staging deployment from main and feature branches", () => {
    expect(() => assertCloudflareDeployBranch("staging", "main")).toThrow(
      'Refusing staging Cloudflare deployment from branch "main"',
    );
    expect(() =>
      assertCloudflareDeployBranch("staging", "feature/example"),
    ).toThrow(
      'Refusing staging Cloudflare deployment from branch "feature/example"',
    );
  });
});
