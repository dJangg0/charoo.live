import { execFileSync } from "node:child_process";

import {
  assertCloudflareDeployBranch,
  type CloudflareDeployTarget,
} from "./cloudflare-deploy-branch";

function getBuildBranch(): string {
  if (process.env.WORKERS_CI === "1") {
    const workersBranch = process.env.WORKERS_CI_BRANCH?.trim();
    if (!workersBranch) {
      throw new Error(
        "WORKERS_CI is set but WORKERS_CI_BRANCH is missing; refusing deployment without a verified branch.",
      );
    }
    return workersBranch;
  }

  if (process.env.GITHUB_ACTIONS === "true") {
    const githubBranch = process.env.GITHUB_REF_NAME?.trim();
    if (!githubBranch) {
      throw new Error(
        "GitHub Actions is set but GITHUB_REF_NAME is missing; refusing deployment without a verified branch.",
      );
    }
    return githubBranch;
  }

  return execFileSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
  }).trim();
}

try {
  const target = process.argv[2];
  if (target !== "production" && target !== "staging") {
    throw new Error(
      'Specify the deployment target as either "production" or "staging".',
    );
  }
  assertCloudflareDeployBranch(target, getBuildBranch());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
