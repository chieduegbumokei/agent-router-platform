# AI-Powered Assistant Platform - one command to rule them all.
# `make help` lists everything.

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

.PHONY: install
install: ## Install backend + frontend dependencies
	cd backend && npm install
	cd frontend && npm install

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

.PHONY: dev
dev: db-up ## Run backend (:4000) + frontend (:3000) + DynamoDB Local, Ctrl-C stops both
	@# a leftover production build in .next breaks `next dev` (chunk 404s) - clear it
	@if [ -f frontend/.next/BUILD_ID ]; then rm -rf frontend/.next; fi
	@trap 'kill 0' INT TERM; \
	( cd backend && npm run dev ) & \
	( cd frontend && npm run dev ) & \
	wait

.PHONY: dev-backend
dev-backend: ## Run only the backend (mock LLM + in-memory store by default)
	cd backend && npm run dev

.PHONY: dev-frontend
dev-frontend: ## Run only the frontend
	cd frontend && npm run dev

.PHONY: start
start: build ## Production mode: build frontend, then run both servers
	@trap 'kill 0' INT TERM; \
	( cd backend && npm run start ) & \
	( cd frontend && npm run start ) & \
	wait

# ---------------------------------------------------------------------------
# Quality
# ---------------------------------------------------------------------------

.PHONY: test
test: test-backend test-frontend ## Run all tests (66 total)

.PHONY: test-backend
test-backend: ## Backend tests (52)
	cd backend && npm test

.PHONY: test-frontend
test-frontend: ## Frontend tests (14)
	cd frontend && npm test

.PHONY: typecheck
typecheck: ## Typecheck both packages
	cd backend && npm run typecheck
	cd frontend && npm run typecheck

.PHONY: check
check: typecheck test ## Typecheck + all tests - run before committing

.PHONY: build
build: ## Production build of the frontend
	cd frontend && npm run build

# ---------------------------------------------------------------------------
# DynamoDB Local (optional - default store is in-memory)
# ---------------------------------------------------------------------------

.PHONY: db-up
db-up: ## Start DynamoDB Local (docker) and create the table
	docker compose up -d
	@echo "Waiting for DynamoDB Local on :8000..."
	@for i in $$(seq 1 30); do curl -s -o /dev/null http://localhost:8000 && break; sleep 0.5; done
	cd backend && npm run create-table

.PHONY: db-down
db-down: ## Stop DynamoDB Local
	docker compose down

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

.PHONY: deploy
deploy: ## Deploy the backend to AWS (SAM, guided first time)
	cd backend && sam build && sam deploy --guided

# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------

.PHONY: clean
clean: ## Remove build artifacts and node_modules
	rm -rf backend/node_modules backend/dist backend/.aws-sam
	rm -rf frontend/node_modules frontend/.next

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
