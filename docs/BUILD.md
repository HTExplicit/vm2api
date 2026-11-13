# 版本与构建

git 里只有源码。`bin/`、`web/dist`、`share/crag` 与 `share/wrap-cli` 里的 ELF / glibc 都不进 git：

- `web/dist`、`kin-api-kernel`、`kin-redact` 与 `kin-egress` 在最终控制面镜像内从 fork 源码构建。`kin-egress` 保留 fork 的出口逻辑并包含 HTTP CONNECT 支持。
- 其余 linux amd64 kernel / helper、Claude CLI、完整签名加密 CRAG native v2 包与 glibc shim 由 [`deploy/payload.json`](../deploy/payload.json) 按大小和 SHA-256 固定。清单的 `release` 指向已公开、不可变的 payload Release，可独立于应用版本；`npm run fetch:payload` 与镜像构建使用同一清单，校验失败即停止。
- 当前载荷来源为官方 `payload-2026.11.13-crag-2.8.17`，配套 CRAG `v2.8.17`。应用基线和资产来源见 [官方 086 构建记录](releases/v1.4.086-binaries.json)；来源与完整性校验不等于生产运行验收。

## 完整应用交付

发版先取得最新 `origin/main` 和应用正式版；若正式版包含尚未进入 `main` 的提交，先保留历史地合入。上游更新固定到审阅过的正式 Release，不自动跟随上游 `main`。

1. 下载并校验目标正式版清单引用的完整资产集，只更新来源可核验的成员，不从未提交的本地 `bin/` 取出厂文件。`--pin` 会重算全部本地文件，仅用于已完整核验的隔离 staging；再以 `--check` 校验、`--stage <目录>` 导出同名资产。
2. 保持载荷下载源与应用版本分离。清单只引用已经公开下载的不可变发行；CRAG 的 `crag_release` 指定独立安装包版本，完整归档由 `share/crag/crag-v2-licensed-amd64.tar.gz` 清单项交付，并与同包八个出厂成员核验签名和字节一致。
3. 提交清单、构建来源、应用 `VERSION` 与 `CHANGELOG.md`，通过 PR CI 后合并。tag 落在包含这些改动的云端合并结果，不能重打历史 tag。
4. 推送 tag 后先建草稿 Release，再构建并推送 linux/amd64 控制面版本镜像。`scripts/release-assets.mjs` 从该最终镜像的精确 digest 提取 21 个上游固定资产和 fork 自编 `kin-egress`，核验来源后生成 `build-provenance.json`，共 23 个附件。
5. 核对附件与镜像，并确认 GHCR 匿名可读取后，工作流才移动 `latest` 并公开 Release。当前不构建 ARM64 helper、ARM64 控制面镜像或多架构 manifest；不另附 `payload.json` 或 `SHA256SUMS`。
6. 发布后按目标版本部署并核验控制面与运行中进程。包下载和出厂文件更新不代表槽内进程已更新；安装、升级与恢复保持现有启停、人工调度及内核选择。CRAG 原生交接只按运行中内核声明的能力启用。

## Codex 组件版本与历史资产

Codex kernel `0.1.2` 是组件版本，不是应用版本；从 `v1.4.071` 起随完整应用清单、Release 和镜像交付。私有源码不进入公开 git，来源与工具链见 [0.1.2 构建记录](releases/codex-kernel-v0.1.2.json)。

历史 `codex-kernel-v0.1.1` / `codex-kernel-v0.1.2` 的三个组件资产保持不变，作为可校验的来源记录，不作为完整应用升级的替代方案。正常升级使用应用 `v*` Release；不要把只替换 `bin/kin-codex-kernel` 当作完整部署。VM Analytics 的槽内身份采集、开关和出口边界见 [OpenAI 传输与隐私](PANEL_API.md#openai-传输与隐私)。

## 版本怎么记

| 记号 | 谁写 | 含义 |
|---|---|---|
| 仓库根 `VERSION` | 人改 | 对外 semver，和 tag 对齐 |
| git tag `v*` | 人打 | 触发 Release 工作流 |
| Actions run 的 commit SHA | GitHub | 对照源码与构建；不再单独上传 `VERSION.txt` |

`VERSION` 是唯一应用版本来源；`package.json` / lockfile 不再重复记录版本。发版当天改 `VERSION` 和 [CHANGELOG.md](../CHANGELOG.md)，再打 annotated tag。`Dockerfile` 把这两个文件拷进控制面镜像，面板才能读当前版本。一键脚本 `deploy/install.sh` 按 GitHub Release tag 升级，不改版本文件。

## 打一个 Release

仓库要有 `contents: write`。流程在 `.github/workflows/release.yml`。

```bash
version=$(cat VERSION)
git tag -a "v$version" -m "vm2api v$version"
git push origin "v$version"
```

`v*` tag 触发上述草稿、构建、核验与发布流程。面板按应用 Release 的同名附件下载 kernel / CLI；`kin-egress` 与其他发布附件来自同一最终镜像：

| 文件 | 角色 |
|---|---|
| `kin-kernel` | Claude Code 槽内核（payload，推理必带） |
| `kin-egress` | fork 源码构建的 SOCKS5 / HTTP CONNECT 透明出口 |
| `kin-slot-gate` | 扩展节点直连通道入口（控制面每请求一条 TLS 连接直达节点槽位） |
| `kin-worker` | **只** `telemetry`，不是 hop |
| `kin-codex-kernel` | Codex 槽（payload） |
| `kin-oauth-auth` | OAuth / Setup Token 换票服务二进制；源码不随部署上传 |
| `kin-kernel-crag` / `cli-node` | CRAG kernel 与槽内 wrap CLI（payload）；`cc-node` 继续可选，不在当前附件内 |

手动重跑正常发行时选择同一不可变 tag。已有草稿可通过 `workflow_dispatch` 的恢复参数复用该 tag 提交对应、CI 成功且摘要匹配的验证镜像；只重填草稿，不改已公开版本附件或历史 tag。

当前控制面使用 `Dockerfile` 多阶段构建，仅发布 amd64。镜像包含控制台、从源码编译的 helper 和固定 payload；Shard 浏览器内核在部署端安装，公开镜像不含内核或授权 key。

槽位 OS 镜像由 `.github/workflows/guest-images.yml` 独立发布：main 上 `docker/kin-os/`、`docker/kin-kvm/` 或该 workflow 有变化时触发，也可手动运行。四种系统并行构建，各用独立缓存；普通应用发版不再重复构建槽位 OS / KVM runner 镜像。

KVM runner 镜像（`ghcr.io/dofastted/kin-kvm-{ubuntu,debian,arch,fedora}`）在同一 workflow 的 `kvm` job 构建：单 Dockerfile `docker/kin-kvm/` + `ARG CLOUD_IMAGE_URL`（官方 cloud image URL 见 `src/lib/vm/os-catalog.mjs` 的 `kvm.cloud_image`）。本机构建：

```bash
node docker/kin-kvm/build.mjs ubuntu          # 与 kin-os 同语义：--force / --pull / --pull-only / 过滤器
```

装到机器上（Compose 部署可跳过，镜像入口会把镜像内的同名文件写进挂载的 `bin/`）：

```bash
install -m 755 kin-kernel kin-egress kin-worker kin-codex-kernel kin-oauth-auth /opt/vm2api/bin/
```

然后按 [DEPLOY.md](DEPLOY.md) 指环境变量。槽进程不是 root：权限必须是 `755`，不要 `700`。

控制面镜像：`docker compose -f docker-compose.yml -f docker-compose.build.yml build` 在镜像内编控制台与 Go helper 并下载 payload，构建机需要能访问 GitHub Release（见 [DEPLOY.md](DEPLOY.md#docker-compose)）。槽位 `kin-os/*` 首次启动编 ubuntu，或 `node docker/kin-os/build.mjs`；KVM 槽编 `kin-kvm-*`，或 `node docker/kin-kvm/build.mjs`。

## 本机构建

依赖：Node 22、Go 1.25、pnpm 10、python3（官方 CLI PTY 脚本）。OAuth 换票由控制面 spawn `bin/kin-oauth-auth` 完成；`auth.js` 只保留在本地构建目录，不上传到控制面。kernel / wrap CLI 用 payload ELF，不要在本机 cargo / 重编 Claude Code。

```bash
npm ci
pnpm -C web install --frozen-lockfile

npm run fetch:payload     # 固定 bin/、share/wrap-cli 与 share/crag；egress 由源码构建
npm run build:web         # web/dist
```

格式：和 CI 同一套，全文 LF。说明见 [FORMAT.md](FORMAT.md)。

```bash
npm run format
npm run format:check
```

本机调试可编译 Go helper。`kin-egress` 不在下载清单内；重编清单内的其他 helper 会使 `fetch:payload --check` 失败，正式发行须按上文固定来源，不能混入本地调试产物：

```bash
CGO_ENABLED=0 go build -trimpath -o bin/kin-egress ./worker/cmd/kin-egress
CGO_ENABLED=0 go build -trimpath -o bin/kin-slot-gate ./worker/cmd/kin-slot-gate
CGO_ENABLED=0 go build -trimpath -o bin/kin-worker ./worker/cmd/kin-worker
pnpm -C web build
```

`kin-worker` 不带参数会退出（hop 已删）。只要：

```bash
kin-worker telemetry --config /path/to/worker.json
```

## 验证

```bash
npm test                  # unit + worker Go（egress / proxy / config / telemetry）
npm run test:web          # 要先 pnpm -C web install
node --check src/server.mjs
```

CI（`.github/workflows/test.yml`）在 main push / PR 上运行，也可手动触发；包含受影响后端与 Go 回归、前端检查，以及 amd64 镜像中的离线 Shard 浏览器验证。CI 不发起真实模型请求，不代表生产验收，也不扩展 ARM64 发布范围。PR 使用该次检出的合并状态；需要验证更新后的主线时刷新 PR 再运行。当前 fork 的 `.github/workflows/pr-rerun.yml` 自动重跑任务关闭。

## 升级一台已部署的机

升 **v1.2.22**：更新控制面和槽内 kernel；一键更新会自动同步且不会 `docker rm` 槽。步骤见 [DEPLOY.md · 已部署机升级到 1.2.22](DEPLOY.md#已部署机升级到-1222)。

**Compose（其它版本通用）**

```bash
cd /opt/vm2api
git pull
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

槽位容器不会被升级脚本无条件 `docker rm`。从 1.2.22 开始，一键更新默认把 `share/wrap-cli` 同步到本机槽并重启槽内 dataplane；集群槽在同一次同步里重建内容哈希镜像并换容器。仅在明确需要延后时使用 `--no-sync-wrap`。

**本机 Node + systemd**

1. `git pull` 或检出目标 tag。
2. `npm ci`；`pnpm -C web install --frozen-lockfile && npm run build:web`；`npm run build:egress && npm run build:worker`。
3. `npm run fetch:payload` 换 `bin/` 和 `share/` ELF，再调用 `POST /api/panel/wrap-cli/sync` 并传 `{"restart":true}`。同步优先 `bin/kin-kernel`。
4. `node --check src/server.mjs`。
5. `systemctl restart vm2api` **一次**。确认 `/health`。

静态 HTML / `web/dist` 单独更新不必重启。同一轮不要 restart 两次，不要 `stop` 后不拉起。


---

交流见仓库 [README](../README.md)。
