.PHONY: venv install test lint fix run release-tarball release clean

PY := ./.venv/bin/python

venv:
	uv venv --python 3.12 .venv

install: venv
	uv pip install --python .venv/bin/python -e ".[dev]"

test:
	$(PY) -m pytest tests -q

lint:
	./.venv/bin/ruff check app tests

fix:
	./.venv/bin/ruff check app tests --fix

run:
	$(PY) -m app.main --config conf/config.ini

check: lint test

# The tarball app/updater.py downloads for a self-upgrade, and scripts/install.sh unpacks.
# Flat on purpose: no directory prefix, because both extract it without stripping
# components. Built from HEAD, so an uncommitted bump would ship the previous version.
VERSION := $(shell python3 -c "import tomllib;print(tomllib.load(open('pyproject.toml','rb'))['project']['version'])")

release-tarball:
	@mkdir -p dist
	git archive --format=tar.gz -o dist/zidane-agent-$(VERSION).tar.gz HEAD
	@cd dist && sha256sum zidane-agent-$(VERSION).tar.gz | tee SHA256SUMS
	@echo "built dist/zidane-agent-$(VERSION).tar.gz"

# Bump, tag, push and publish to GitHub Releases. `make release VERSION=0.2.0`, or with
# no VERSION to release what pyproject.toml already says.
# VERSION defaults to what pyproject.toml already says, and release.sh treats "bump to
# the version I already am" as a no-op — so both forms do the right thing.
release:
	./scripts/release.sh $(VERSION)

clean:
	rm -rf state work logs dist .pytest_cache **/__pycache__
