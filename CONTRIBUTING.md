# Contributing

Thanks for your interest. Conclavix is in early development; please open an issue before starting
larger work so we can agree on the direction.

## Contributor licence agreement

Conclavix is dual-licensed (AGPL-3.0 and a commercial licence). Before we can merge your first
pull request, you need to sign our contributor licence agreement. The CLA bot will ask you to do
so on your pull request.

## Pull requests

- Keep them small and focused on one change.
- `pnpm check` must pass locally; CI runs the same steps.
- New behaviour needs tests. Bug fixes need a test that fails without the fix.
- Commit messages explain what changed and why.

## Pull requests from forks

Workflows of a pull request from a fork only start after a maintainer approved them (repository
setting "Require approval for all outside collaborators"). CI runs on the `pull_request` event and
gets no secrets. The automated review and the auto-fixer skip fork pull requests entirely: they
need repository secrets, and the fixer only handles same-repository pull requests of trusted
authors. A maintainer reviews fork pull requests by hand; see [docs/review.md](docs/review.md) and
[docs/fixer.md](docs/fixer.md).
