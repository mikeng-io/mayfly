# Cost comparison — GitHub-hosted runners vs Mayfly (private repo)

_Marginal cost, private repo, Linux, **after** the plan's included free minutes. 2026-07-11._
_Mayfly numbers use the **real** ap-northeast-1 `lambda-microvms` pricing (pulled from the AWS Price List API)._

> Interactive version: `docs/mayfly-cost.html` (vCPU/memory + volume sliders on the real rates).

## Two framing facts

1. **Self-hosted runners consume zero GitHub Actions minutes.** GitHub only bills minutes for its
   *hosted* runners. So this is **GitHub's per-minute bill vs your AWS bill**.
2. **GitHub bills rounded up to the whole minute, per job; Mayfly (AWS) bills per-second.** The only
   place that rounding clearly wins is short/frequent jobs.

## Real prices (AWS Price List API, ap-northeast-1 / Tokyo)

| Dimension | ARM (Graviton) | x86 |
|---|---|---|
| vCPU-second | **$0.0000322421** | $0.0000371569 |
| GB-second (memory) | **$0.0000042688** | $0.0000049195 |
| Snapshot storage | $0.0001333/GB-hour (= $0.096/GB-mo) | — |
| Snapshot read / write | $0.00185 / $0.00466 per GB | — |

**A MicroVM's compute rate = `vCPU × vCPU-sec + GB × GB-sec`, per second.** For common ARM sizes:

| MicroVM | $/min | vs GitHub arm64 ($0.005/min) |
|---|---|---|
| 1 vCPU / 2 GB | $0.00245 | ~2× cheaper |
| **2 vCPU / 4 GB** | **$0.00489** | **≈ equal** |
| 2 vCPU / 8 GB | $0.00592 | ~18% more |
| 4 vCPU / 8 GB | $0.00979 | ~2× more |

GitHub-hosted (rounded up per job): **arm64 2-core $0.005/min · x64 2-core $0.008/min.**
Mayfly boot overhead ~20 s/job (billed). Mayfly fixed ~$5/mo (control plane idle + image snapshot).

## Cost per job (2 vCPU / 4 GB ARM Mayfly)

| Job wall time | GitHub x64 | GitHub arm64 | Mayfly (+20 s boot) |
|---|---|---|---|
| 20 sec | $0.0080 | $0.0050 | **$0.0033** |
| 2 min | $0.0160 | $0.0100 | $0.0114 |
| 8 min | $0.0640 | $0.0400 | $0.0408 |
| 30 min | $0.2400 | $0.1500 | $0.1484 |

## Monthly total (avg 6-min job, incl. Mayfly $5 fixed)

| Jobs / mo | GitHub x64 | GitHub arm64 | Mayfly |
|---|---|---|---|
| 200 | $9.60 | $6.00 | $11.20 |
| 500 | $24.00 | $15.00 | $20.50 |
| 1,000 | $48.00 | $30.00 | $36.00 |
| 5,000 | $240 | $150 | $160 |
| 20,000 | $960 | $600 | $625 |

**Break-even vs x64 ≈ ~290 jobs/mo. Vs arm64: essentially never** — a 2 vCPU/4 GB MicroVM's compute
already matches arm64-hosted, so Mayfly's $5 fixed + boot keep it slightly *above* arm64 at every volume.

## Verdict (honest — the real pricing changed it)

- **Vs GitHub arm64-hosted: cost is a wash-to-slightly-worse.** Same compute rate for a 2-core VM, plus
  Mayfly's fixed + boot. Mayfly only undercuts arm64 on **very short jobs** (per-second vs rounded minute)
  or with a **smaller VM** (1 vCPU/2 GB).
- **Vs GitHub x64-hosted: Mayfly is cheaper above ~290 jobs/mo** (x64-hosted carries a bigger premium).
- **This excludes ops labor** to run the control plane — the real hidden cost of self-hosting.
- **So don't choose Mayfly to save money.** Its durable advantages are **own-kernel isolation for
  untrusted CI**, **warm-start-at-zero-idle**, and **VPC access**. The real pricing reinforces the
  findings' positioning: cost is at best a tie, occasionally a win — never the headline.
- Fair alternatives to weigh: **CodeBuild-hosted GitHub runners** and **ARC on EKS**.
