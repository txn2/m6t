# m6t Makefile — the quality leash.
#
# `make verify` is the single CI-parity gate: every check it runs has an
# equivalent job in .github/workflows/ci.yml with the same threshold, so a
# green verify on a diff means CI cannot fail on that diff FOR A REASON THAT
# IS IN THE DIFF. Keeping that true is a maintained invariant — pins_test.go
# fails the build when a figure here and a figure in CI/codecov/CONTRIBUTING
# drift apart.
#
# What it cannot cover, and no local gate can: the runner's own machinery.
# CI reaches each of these targets through a GitHub Action that downloads
# tools, restores caches and — until this was turned off — fetched a JSON
# schema over HTTP before linting anything. A failure there is infrastructure,
# not a finding, and verify is structurally blind to it.
#
# So when CI is red and verify was green, read the log before touching the
# code. Two outcomes, and they need opposite responses: a finding against the
# diff means the parity claim above has a hole and the hole gets fixed, while
# an error from the wrapper means the workflow is depending on something it
# should not be depending on. Neither is fixed by guessing at the diff.

BINARY_NAME := m6t
MODULE := github.com/txn2/m6t

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT ?= $(shell git rev-parse HEAD 2>/dev/null || echo "none")
BUILD_DATE ?= $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')

BUILD_DIR := ./build/bin
FRONTEND_DIR := ./frontend

LDFLAGS := -X $(MODULE)/internal/buildinfo.version=$(VERSION) \
	-X $(MODULE)/internal/buildinfo.commit=$(COMMIT) \
	-X $(MODULE)/internal/buildinfo.date=$(BUILD_DATE)

# Tool versions — the single source of truth. .github/workflows/ci.yml and
# CONTRIBUTING.md must name these same versions; TestToolPinsAgree fails when
# they drift. Local-vs-CI tool drift is the most insidious parity gap: two
# golangci-lint or gosec versions enable different rules, so verify can pass
# locally while CI rejects the identical diff.
GOLANGCI_LINT_VERSION := v2.11.4
GOSEC_VERSION := v2.28.0
GREMLINS_VERSION := v0.6.0
WAILS_VERSION := v2.13.0

# Coverage floors. COVERAGE_MIN is the total-coverage gate;
# PATCH_COVERAGE_MIN holds NEW code above it so the total can only ratchet up.
# Both figures are mirrored in ci.yml, codecov.yml and CONTRIBUTING.md, and
# TestGateFiguresAgree fails when any copy disagrees.
COVERAGE_MIN := 80
PATCH_COVERAGE_MIN := 85

# Mutation-testing efficacy floor for `verify-release`.
MUTATION_EFFICACY_MIN := 60

# Dependency license allowlist. Permissive only: m6t is Apache-2.0 and must
# stay linkable into a future commercial edition (DESIGN.md §9.1).
GO_LICENSE_ALLOWLIST := MIT,BSD-2-Clause,BSD-3-Clause,Apache-2.0,ISC,0BSD

GO := go
GOTEST := $(GO) test
GOBUILD := $(GO) build
GOLINT := golangci-lint
WAILS := wails

# Wails links the system webview. On Linux it defaults to webkit2gtk-4.0,
# which is EOL and absent from current distros (Ubuntu 24.04 ships 4.1 only),
# so Linux builds select 4.1 with this tag. DESIGN.md §9 names webkit2gtk-4.1
# as the Linux dependency; this is what makes the build honour that. Empty on
# macOS and Windows, which use WKWebView and WebView2.
ifeq ($(shell uname -s),Linux)
WAILS_BUILD_TAGS := -tags webkit2_41
else
WAILS_BUILD_TAGS :=
endif

.PHONY: all help tools-check fmt lint lint-full lint-fix test coverage coverage-report \
	patch-coverage security semgrep codeql sast osv dead-code licenses licenses-go \
	licenses-js build build-check clean mutate verify verify-release dev run \
	frontend-install frontend-build frontend-lint frontend-typecheck frontend-test \
	bindings bindings-check

## all: Build, test and lint
all: build test lint

## help: Show this help message
help:
	@echo "m6t Makefile"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'

# =============================================================================
# Toolchain
# =============================================================================

## tools-check: Verify required tools are installed AND pinned to the CI versions
##
## Nothing else in `verify` runs without this. A local tool that differs from
## CI's silently breaks the parity guarantee verify exists to provide.
tools-check:
	@echo "Checking required tools (presence AND pinned versions)..."
	@missing=""; mismatch=""; \
	check_pinned() { \
		name=$$1; want=$$2; install=$$3; probe=$$4; \
		if ! command -v $$name > /dev/null 2>&1; then \
			missing="$$missing  $$name: $$install\n"; \
			return 0; \
		fi; \
		v=$$(go version -m $$(command -v $$name) 2>/dev/null | awk -v n="$$name" '$$1=="mod" && $$2 ~ n {print $$3}' | head -1); \
		if [ -z "$$v" ] || [ "$$v" = "(devel)" ]; then \
			v=$$(eval "$$probe" 2>&1 | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -1); \
			case "$$v" in v*) ;; ?*) v="v$$v";; esac; \
		fi; \
		if [ "$$v" != "$$want" ]; then \
			mismatch="$$mismatch  $$name: have $${v:-unknown}, want $$want — $$install\n"; \
		fi; \
	}; \
	check_pinned golangci-lint $(GOLANGCI_LINT_VERSION) \
		"go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)" \
		"golangci-lint version"; \
	check_pinned gosec $(GOSEC_VERSION) \
		"go install github.com/securego/gosec/v2/cmd/gosec@$(GOSEC_VERSION)" \
		"gosec --version"; \
	check_pinned gremlins $(GREMLINS_VERSION) \
		"go install github.com/go-gremlins/gremlins/cmd/gremlins@$(GREMLINS_VERSION)" \
		"gremlins --version"; \
	check_pinned wails $(WAILS_VERSION) \
		"go install github.com/wailsapp/wails/v2/cmd/wails@$(WAILS_VERSION)" \
		"wails version"; \
	command -v govulncheck > /dev/null 2>&1 || missing="$$missing  govulncheck: go install golang.org/x/vuln/cmd/govulncheck@latest\n"; \
	command -v semgrep > /dev/null 2>&1     || missing="$$missing  semgrep: pip3 install semgrep\n"; \
	command -v deadcode > /dev/null 2>&1    || missing="$$missing  deadcode: go install golang.org/x/tools/cmd/deadcode@latest\n"; \
	command -v go-licenses > /dev/null 2>&1 || missing="$$missing  go-licenses: go install github.com/google/go-licenses@latest\n"; \
	command -v npm > /dev/null 2>&1         || missing="$$missing  npm: install Node.js 22+ (https://nodejs.org)\n"; \
	if [ -n "$$missing" ]; then \
		echo ""; \
		echo "FAIL: Missing required tools:"; \
		printf '%b' "$$missing"; \
		echo "Install them before running make verify."; \
		exit 1; \
	fi; \
	if [ -n "$$mismatch" ]; then \
		echo ""; \
		echo "FAIL: Tool version mismatch (local differs from the CI pin)."; \
		echo "A local version that drifts from CI's is a silent parity gap:"; \
		echo "make verify can pass while CI rejects the same diff."; \
		echo ""; \
		printf '%b' "$$mismatch"; \
		echo "Pin local tools to the versions above before running make verify."; \
		echo "(Override with TOOLS_CHECK_STRICT=0 only if you know what you are doing.)"; \
		if [ "$(TOOLS_CHECK_STRICT)" != "0" ]; then exit 1; fi; \
		echo "WARN: proceeding with mismatched tool versions (TOOLS_CHECK_STRICT=0)."; \
	else \
		echo "All required tools found at pinned CI versions."; \
	fi

# =============================================================================
# Go gates
# =============================================================================

## fmt: Fail on gofmt drift (this gate reports, it does not rewrite)
##
## `make fmt-fix` rewrites. A formatting gate that silently fixes hides the
## drift from the diff under review.
fmt:
	@echo "Checking formatting..."
	@DRIFT=$$(gofmt -s -l . | grep -v '^frontend/' || true); \
	if [ -n "$$DRIFT" ]; then \
		echo "FAIL: gofmt -s drift in:"; \
		echo "$$DRIFT" | sed 's/^/  /'; \
		echo "Run 'make fmt-fix'."; \
		exit 1; \
	fi
	@echo "Formatting is clean."

## fmt-fix: Rewrite files to gofmt -s
fmt-fix:
	@gofmt -s -w .

## lint: Patch-scoped golangci-lint (matches CI's --new-from-rev scope)
##
## CI reports only issues on lines the PR changed. This target mirrors that
## scope, with one addition: --new-from-rev sees only COMMITTED changes, so
## before the first commit the patch would be empty and lint a no-op. Passing
## a patch built from the merge-base that includes working-tree changes makes
## `make verify` a true pre-commit gate.
##
## `make lint-full` scans everything; it is housekeeping, not part of verify.
lint:
	@echo "Running patch-scoped lint (CI parity: only new issues, incl. uncommitted)..."
	@./scripts/require-tracked.sh lint '*.go'
	@git fetch --quiet origin main 2>/dev/null || true
	@if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then \
		BASE=origin/main; \
	elif git rev-parse --verify --quiet main >/dev/null 2>&1; then \
		BASE=main; \
	else \
		echo "ERROR: neither origin/main nor main is reachable."; \
		echo "       Run 'git fetch origin main' and retry."; \
		echo "       (lint MUST run against a base; silent-skip is a CI-parity hole.)"; \
		exit 1; \
	fi; \
	MERGE_BASE=$$(git merge-base $$BASE HEAD 2>/dev/null); \
	if [ -z "$$MERGE_BASE" ]; then \
		echo "ERROR: could not compute a merge-base against $$BASE."; \
		exit 1; \
	fi; \
	PATCH=$$(mktemp -t m6t-lint-patch.XXXXXX); \
	trap "rm -f $$PATCH" EXIT; \
	git diff $$MERGE_BASE > $$PATCH; \
	if [ ! -s $$PATCH ]; then \
		echo "No changes vs merge-base ($$BASE); nothing to lint."; \
		exit 0; \
	fi; \
	echo "Linting against merge-base $$MERGE_BASE (from $$BASE)"; \
	$(GOLINT) run --new-from-patch=$$PATCH ./...

## lint-full: Lint the entire codebase (housekeeping; not part of verify)
lint-full:
	@$(GOLINT) run ./...

## lint-fix: Lint with auto-fix
lint-fix:
	@$(GOLINT) run --fix ./...

## test: Run the Go test suite (race, shuffled, uncached)
test:
	@echo "Running tests..."
	$(GOTEST) -race -shuffle=on -count=1 -coverprofile=coverage.out -covermode=atomic ./...

## coverage: Write an HTML coverage report
coverage: test
	@$(GO) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

## coverage-report: Print the coverage summary (fails below COVERAGE_MIN)
coverage-report: test
	@echo ""
	@echo "=== Coverage Summary ==="
	@$(GO) tool cover -func=coverage.out | tail -1
	@TOTAL=$$($(GO) tool cover -func=coverage.out | tail -1 | awk '{gsub(/%/,"",$$3); print $$3}'); \
	if [ "$$(awk -v t="$$TOTAL" -v m=$(COVERAGE_MIN) 'BEGIN{print (t < m) ? 1 : 0}')" = "1" ]; then \
		echo "FAIL: total coverage $$TOTAL% is below the $(COVERAGE_MIN)% floor"; \
		exit 1; \
	fi
	@echo ""
	@echo "Functions with 0% coverage:"
	@$(GO) tool cover -func=coverage.out | awk '{gsub(/%/,"",$$3); if ($$3+0 == 0 && $$1 != "total:") print "  " $$0}' || true
	@echo "Functions below the $(PATCH_COVERAGE_MIN)% patch floor:"
	@$(GO) tool cover -func=coverage.out | awk '{gsub(/%/,"",$$3); if ($$3+0 < $(PATCH_COVERAGE_MIN) && $$3+0 > 0 && $$1 != "total:") print "  " $$0}' || true
	@echo "=== End Coverage ==="

## patch-coverage: Coverage of lines changed vs main (fails below PATCH_COVERAGE_MIN)
patch-coverage:
	@PATCH_COVERAGE_THRESHOLD=$(PATCH_COVERAGE_MIN) ./scripts/patch-coverage.sh

## security: gosec + govulncheck
##
## G204 is excluded HERE ONLY, and it is still enforced. gosec runs twice in
## this repo: standalone (this target) and inside golangci-lint, where
## .golangci.yml scopes G204 off for internal/git alone and explains why —
## driving the user's git with a worktree path IS the product, so the rule
## fires on every correct invocation there. Standalone gosec has no path
## scoping, so the choice is this flag or a //nolint in the source, and
## CLAUDE.md rules out the second. Every package outside internal/git is still
## checked for G204, by the golangci-lint run in `make lint`.
security:
	@echo "Running gosec..."
	gosec -quiet -exclude=G204 ./...
	@echo "Running govulncheck..."
	govulncheck ./...

## semgrep: Semgrep SAST (registry p/golang plus this repo's rules)
semgrep:
	@echo "Running Semgrep..."
	semgrep scan --config p/golang --config .semgrep/ --error --quiet .

## codeql: CodeQL analysis gated against the committed baseline (requires the codeql CLI)
##
## Not in `verify`: a database build takes minutes. CI runs it on every PR via
## codeql.yml; run this locally before touching taint-sensitive code.
codeql:
	@echo "Running CodeQL analysis..."
	@rm -rf /tmp/m6t-codeql-db
	codeql database create /tmp/m6t-codeql-db --language=go --source-root=. --overwrite
	@codeql database analyze /tmp/m6t-codeql-db \
		--format=sarif-latest --output=codeql-results.sarif \
		codeql/go-queries:codeql-suites/go-security-and-quality.qls
	@python3 scripts/codeql-gate.py codeql-results.sarif

## sast: All SAST scanners (semgrep + codeql)
sast: semgrep codeql

## osv: osv-scanner over the whole dependency graph (informational)
##
## Not in `verify`: osv-scanner reports regardless of reachability, so it flags
## indirect/test-only deps that never reach the binary. govulncheck (in
## `security`) is the reachability-aware gate.
osv:
	@echo "Running osv-scanner (informational)..."
	@osv-scanner scan source -r --config osv-scanner.toml . || true

## dead-code: Report unreachable functions (surfaced in verify, not blocking)
##
## Wails-bound methods are called from TypeScript, so this reports some of them.
## Read the output; do not treat it as a pass/fail signal.
dead-code:
	@echo "Checking for dead code..."
	@OUTPUT=$$(deadcode ./... 2>&1 | grep -v "^$$") || true; \
	if [ -n "$$OUTPUT" ]; then \
		echo "Dead code detected (review for false positives):"; \
		echo "$$OUTPUT" | sed 's/^/  /'; \
	else \
		echo "No dead code found."; \
	fi

## mutate: Mutation testing (fails below MUTATION_EFFICACY_MIN) — verify-release only
mutate:
	@echo "Running mutation testing..."
	gremlins unleash --workers 1 --timeout-coefficient 3 \
		--threshold-efficacy $(MUTATION_EFFICACY_MIN) ./internal/...

# =============================================================================
# Licensing
# =============================================================================

## licenses: Gate every linked dependency against the permissive allowlist
licenses: licenses-go licenses-js

## licenses-go: go-licenses against the Go dependency graph
licenses-go:
	@echo "Checking Go dependency licenses..."
	@go-licenses check ./... --allowed_licenses="$(GO_LICENSE_ALLOWLIST)" \
		--ignore=$(MODULE)

## licenses-js: license checker against the production npm graph
licenses-js: frontend-install
	@echo "Checking npm dependency licenses..."
	@cd $(FRONTEND_DIR) && npm run --silent licenses

# =============================================================================
# Frontend gates
# =============================================================================

## frontend-install: Install frontend dependencies from the lockfile
frontend-install:
	@cd $(FRONTEND_DIR) && npm ci --no-audit --no-fund

## frontend-typecheck: tsc --noEmit over the frontend
frontend-typecheck: frontend-install
	@echo "Type-checking the frontend..."
	@cd $(FRONTEND_DIR) && npm run --silent typecheck

## frontend-lint: Complexity/coupling gate (eslint) plus type checking
frontend-lint: frontend-typecheck
	@echo "Linting the frontend..."
	@cd $(FRONTEND_DIR) && npm run --silent lint

## frontend-test: Frontend unit tests (vitest)
frontend-test: frontend-install
	@echo "Running frontend tests..."
	@cd $(FRONTEND_DIR) && npm run --silent test

## frontend-build: Build the frontend into frontend/dist (embedded by the Go binary)
frontend-build: frontend-install
	@cd $(FRONTEND_DIR) && npm run --silent build
	@# vite empties dist/ on every build, including the tracked placeholder that
	@# keeps `//go:embed all:frontend/dist` satisfiable in a fresh clone.
	@touch $(FRONTEND_DIR)/dist/.gitkeep

# =============================================================================
# Build
# =============================================================================

## bindings: Regenerate the TypeScript bindings from the bound Go methods
bindings:
	@$(WAILS) generate module
	@# Wails writes generated files 0755. Normalizing keeps a regenerate from
	@# showing up in `git status` as a mode-only change on files that are not
	@# executable in the first place.
	@find $(FRONTEND_DIR)/wailsjs -type f -exec chmod 644 {} +

## bindings-check: Fail when the committed bindings are stale
##
## Content only. Wails writes these files with an unstable exec bit — `wails
## generate module` emits 0755 and `wails build` emits 0644 for the same
## bytes — so a mode comparison would fail depending on which command ran
## last. core.fileMode=false is scoped to this one command over the generated
## tree; a binding whose API actually drifted still fails.
bindings-check: bindings
	@# A newly bound package produces a NEW binding file, which is untracked and
	@# therefore invisible to the comparison below — the gate would report the
	@# bindings current while a whole module was missing from them.
	@./scripts/require-tracked.sh bindings-check '$(FRONTEND_DIR)/wailsjs'
	@if git -c core.fileMode=false diff --quiet -- $(FRONTEND_DIR)/wailsjs; then \
		echo "Wails bindings are up to date."; \
	else \
		echo "FAIL: frontend/wailsjs is stale. Run 'make bindings' and commit the result."; \
		git -c core.fileMode=false --no-pager diff --stat -- $(FRONTEND_DIR)/wailsjs; \
		exit 1; \
	fi

## build: Build the desktop application for the host platform
build:
	@echo "Building $(BINARY_NAME) $(VERSION)..."
	@$(WAILS) build -clean $(WAILS_BUILD_TAGS) -ldflags "$(LDFLAGS)" -o $(BINARY_NAME)
	@echo "Built: $(BUILD_DIR)/$(BINARY_NAME)"

## build-check: Compile everything, verify the module graph, and smoke the app build
build-check: frontend-build
	@echo "Building Go packages..."
	@$(GOBUILD) ./...
	@echo "Verifying module checksums..."
	@$(GO) mod verify
	@echo "Smoke-building the desktop app..."
	@$(WAILS) build -s $(WAILS_BUILD_TAGS) -ldflags "$(LDFLAGS)" -o $(BINARY_NAME)
	@test -e $(BUILD_DIR)/$(BINARY_NAME) || test -d $(BUILD_DIR)/$(BINARY_NAME).app \
		|| { echo "FAIL: wails build produced no artifact in $(BUILD_DIR)"; exit 1; }
	@echo "Build smoke passed."

## dev: Run the app with hot reload
dev:
	@$(WAILS) dev

## run: Build and run the app
run: build
	@$(BUILD_DIR)/$(BINARY_NAME)

## clean: Remove build and coverage artifacts
clean:
	@rm -rf $(BUILD_DIR) coverage.out coverage.html codeql-results.sarif
	@rm -rf $(FRONTEND_DIR)/dist/* $(FRONTEND_DIR)/node_modules
	@touch $(FRONTEND_DIR)/dist/.gitkeep
	@echo "Clean complete."

# =============================================================================
# The gate
# =============================================================================

## verify: The CI-parity gate — run this before proposing any commit
##
## Every check here has an equivalent CI job at the same threshold. Mutation
## testing is deliberately excluded (it is expensive and per-release); it lives
## in verify-release. Do not add `mutate` to this target.
verify: tools-check fmt test coverage-report patch-coverage lint security semgrep \
	licenses frontend-lint frontend-test bindings-check build-check dead-code
	@echo ""
	@echo "=== All checks passed ==="

## verify-release: verify plus mutation testing — run before tagging a release
verify-release: verify mutate
	@echo ""
	@echo "=== Release verification complete (incl. mutation testing) ==="
