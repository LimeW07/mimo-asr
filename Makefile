SHELL := /bin/bash
IMAGE  ?= mimo-asr
TAG    ?= latest
PORT   ?= 8000

.PHONY: help install run smoke e2e docker-build docker-run docker-stop compose-up compose-down

help:
	@echo "make install     创建 venv 并安装依赖"
	@echo "make run         本地启动 (http://127.0.0.1:8000)"
	@echo "make smoke       后端冒烟测试 (需服务与 mock 已启动)"
	@echo "make e2e         浏览器端到端测试 (需 Chrome CDP)"
	@echo "make docker-build 构建镜像 ($(IMAGE):$(TAG))"
	@echo "make docker-run  运行容器"
	@echo "make compose-up  docker compose 一键启动"

install:
	python3 -m venv .venv
	.venv/bin/pip install -r requirements.txt

run:
	./scripts/run.sh

smoke:
	bash tests/smoke.sh

e2e:
	node tests/cdp_test.mjs

docker-build:
	docker build --build-arg VERSION=$(TAG) -t $(IMAGE):$(TAG) .

docker-run:
	docker run -d --name mimo-asr -p $(PORT):8000 --restart unless-stopped $(IMAGE):$(TAG)

docker-stop:
	docker rm -f mimo-asr || true

compose-up:
	docker compose up -d --build

compose-down:
	docker compose down
