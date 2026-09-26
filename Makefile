.PHONY: setup run test clean

setup:
	@echo "Setting up environment..."
	corepack enable pnpm >/dev/null 2>&1 || true
	pnpm install
	pnpm build

run:
	@echo "Starting AI Harness..."
	AI_API_KEY=$(AI_API_KEY) pnpm start

test:
	@echo "Running tests..."
	AI_API_KEY=$(AI_API_KEY) pnpm verify

clean:
	@echo "Removing generated artefacts..."
	pnpm -r exec rm -rf dist
	rm -rf .data-local
