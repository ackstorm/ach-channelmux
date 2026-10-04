CHART := chart

.PHONY: help
help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

.PHONY: test
test: ## Gateway tests + Helm lint
	npm test
	helm lint $(CHART) --set publicUrl=http://ach-channelmux.ach.svc --set authResolver.url=http://whoami.example --set authResolver.header=X-Token

.PHONY: image
image: ## Build the image locally as ach-channelmux:dev
	docker build -t ach-channelmux:dev .

##@ Release

.PHONY: release-bump
release-bump: ## Internal: bump chart and package versions. Used by release.yml; prefer release-cut.
	@test -n "$(VERSION)" || (echo "ERROR: VERSION=X.Y.Z required (no leading 'v')" >&2; exit 1)
	@echo "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$$' || \
		(echo "ERROR: VERSION must be semver without leading 'v' (e.g. 0.0.3 or 0.1.0-rc1)" >&2; exit 1)
	@sed -i -E 's/^version: .*/version: $(VERSION)/' $(CHART)/Chart.yaml
	@sed -i -E 's/^appVersion: .*/appVersion: v$(VERSION)/' $(CHART)/Chart.yaml
	@sed -i -E 's|^([[:space:]]+)tag: v.*|\1tag: v$(VERSION)|' $(CHART)/values.yaml
	@npm version $(VERSION) --no-git-tag-version --allow-same-version >/dev/null
	@echo "Manifests bumped to v$(VERSION)."

.PHONY: release-cut
release-cut: ## Cut a release: empty `chore(release): vX.Y.Z` commit pushed to main. Usage: make release-cut VERSION=X.Y.Z
	@test -n "$(VERSION)" || (echo "ERROR: VERSION=X.Y.Z required (no leading 'v')" >&2; exit 1)
	@echo "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$$' || \
		(echo "ERROR: VERSION must be semver without leading 'v' (e.g. 0.0.3 or 0.1.0-rc1)" >&2; exit 1)
	@branch=$$(git rev-parse --abbrev-ref HEAD); \
	test "$$branch" = "main" || (echo "ERROR: must be on main (current: $$branch)" >&2; exit 1)
	@git diff --quiet || (echo "ERROR: working tree dirty; commit or stash first" >&2; exit 1)
	@git diff --cached --quiet || (echo "ERROR: index has staged changes; commit or reset first" >&2; exit 1)
	@git fetch origin main --quiet
	@local=$$(git rev-parse HEAD); remote=$$(git rev-parse origin/main); \
	test "$$local" = "$$remote" || (echo "ERROR: local main differs from origin/main; rebase or pull first" >&2; exit 1)
	$(MAKE) test
	git commit --allow-empty -m "chore(release): v$(VERSION)"
	git push origin main
	@echo ""
	@echo "release.yml is now running. Watch with:"
	@echo "  gh run watch \$$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
