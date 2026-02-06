up:
	docker compose up -d --build

down:
	docker compose down -v

demo:
	npm run demo

chaos-dbdown:
	bash scripts/chaos-db-down.sh

test:
	npm test

lint:
	npm run lint
