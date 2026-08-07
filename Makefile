.PHONY: venv install test lint fix run clean

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

clean:
	rm -rf state work logs .pytest_cache **/__pycache__
