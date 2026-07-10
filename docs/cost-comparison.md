# Cost: GitHub-hosted vs Mayfly — *not* the reason to pick Mayfly

_Private repo, marginal cost after the free tier. Real ap-northeast-1 `lambda-microvms` pricing._

**Bottom line: Mayfly doesn't save money.** A 2 vCPU / 4 GB ARM MicroVM is **$0.0049/min** — about the
same as a GitHub-hosted **arm64** 2-core (**$0.005/min**). Add Mayfly's ~$5/mo control plane, ~20 s boot
per job, and the ops of running it, and it lands **a wash-to-slightly-more vs arm64-hosted** — cheaper
only than the pricier **x64**-hosted, and only above ~290 jobs/mo. Most small repos never leave GitHub's
free tier (effectively $0), where Mayfly still has a floor cost.

| avg 6-min job | GitHub arm64 | GitHub x64 | Mayfly (2c/4 GB ARM) |
|---|---|---|---|
| per job | $0.030 | $0.048 | $0.031 (+ ~$5/mo fixed) |
| 1,000 jobs/mo | $30 | $48 | $36 |

Real Tokyo ARM rates: **$0.0000322421/vCPU-s + $0.0000042688/GB-s** (self-hosted runners also burn **zero**
GitHub Actions minutes; GitHub rounds up to the minute, Mayfly bills per-second — the one short-job edge).

**Choose Mayfly for own-kernel isolation, warm-start-at-zero-idle, and VPC access — not the bill.**
Interactive breakdown (vCPU/memory + volume sliders on the real rates): `docs/mayfly-cost.html`.
