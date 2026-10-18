# Contributing Guide

Thank you for considering contributing to DramaClaw. Whether it is fixing a bug, improving the docs, or adding a feature, all contributions are welcome.

## Before you start

- Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.
- About licensing: this project uses the [Elastic License 2.0](LICENSE) (source available). **Before submitting a contribution, please take a minute to read the [LICENSE](LICENSE) and the [Contributor Agreement](#contributor-agreement) below.**
- Do not report security issues through public issues; see [SECURITY.md](SECURITY.md).

## Reporting bugs / suggesting features

- **Bug**: open a [Bug report](https://github.com/dramaclaw/dramaclaw/issues/new?template=bug_report.yml) with reproduction steps, runtime environment, and relevant logs.
- **Feature suggestion**: open a [Feature request](https://github.com/dramaclaw/dramaclaw/issues/new?template=feature_request.yml) that explains the scenario and motivation.
- Not sure where to start? Look at issues labeled [`good first issue`](https://github.com/dramaclaw/dramaclaw/labels/good%20first%20issue).

## Submitting a PR

### Local development

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw
uv sync
cp .env.example .env      # configure the model gateway per the docs
uv run novelvideo api --port 8780
```

### Workflow

1. Fork the repository and create a topic branch from `main`;
2. Make your changes and test them (`uv run pytest`);
3. Write clear commit messages (we suggest [Conventional Commits](https://www.conventionalcommits.org/)), and add a DCO sign-off to **every commit** with `git commit -s` (see [Developer Certificate of Origin](#developer-certificate-of-origin-dco));
4. Open a PR, link the related issue, and briefly describe the change and how you verified it.

## Contributor Agreement

By submitting a contribution to this project, you agree that:

a. The maintainers may adjust the license adopted by this project as needed (stricter or more permissive);
b. The code you contribute may be used commercially, including but not limited to operating DramaClaw's cloud / hosted business.

> This clause lets DramaClaw, under a source-available license, also use community contributions in the official hosted/commercial edition. It is the premise for "one codebase, with the community and commercial editions not diverging". Submitting a contribution counts as acceptance; no separate signature is needed.

## Developer Certificate of Origin (DCO)

This project requires all contributions to be signed off under the DCO (Developer Certificate of Origin 1.1, full text in [`DCO`](./DCO)). **Every commit must carry a `Signed-off-by` line**, declaring that you have the right to submit the contribution under this project's license.

The simplest way is to add `-s` when committing; git will append the sign-off line using your `user.name` / `user.email`:

```bash
git commit -s -m "fix: ..."
# Automatically generates: Signed-off-by: Your Name <you@example.com>
```

To sign off historical commits: `git rebase --signoff <base>`. CI (`.github/workflows/dco.yml` calling `scripts/check_dco.py`) checks every commit in a PR, and a missing sign-off turns the check red.

## Getting help

[Discussions](https://github.com/dramaclaw/dramaclaw/discussions) | [Issues](https://github.com/dramaclaw/dramaclaw/issues)
