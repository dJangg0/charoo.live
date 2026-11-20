export type CloudflareDeployTarget = "production" | "staging";

export function assertCloudflareDeployBranch(
  target: CloudflareDeployTarget,
  branch: string,
): void {
  const expectedBranch = target === "production" ? "main" : "staging";

  if (branch !== expectedBranch) {
    throw new Error(
      `Refusing ${target} Cloudflare deployment from branch "${branch || "(unknown)"}". ` +
        `Deploy ${target} only from "${expectedBranch}".`,
    );
  }
}
