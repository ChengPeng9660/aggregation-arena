# 更新网站部署教程

本教程说明：当仓库代码有更新后（无论是你本人提交，还是合作者通过 Pull Request / Push 更新），如何把最新版本重新部署到 Cloudflare Workers。

> 项目技术栈：Next.js 16 + Vinext + Vite + Cloudflare Worker + D1。  
> 部署目标：Cloudflare Workers（由 `wrangler.jsonc` 与 `.openai/hosting.json` 共同配置）。

---

## 前置条件

- 已安装 Node.js `>=22.13.0`（推荐 v22 LTS 或更高）。
- 已安装 npm。
- 已登录 Cloudflare Wrangler（运行过 `wrangler login`）。
- 当前目录为项目根目录。

检查方式：

```bash
node --version
npm --version
wrangler whoami
```

---

## 标准部署流程

### 1. 拉取最新代码

如果你是本地已有仓库，先同步远程最新提交：

```bash
git pull origin main
```

验证是否拿到最新版本：

```bash
git log --oneline -3
git status -sb
```

`git status -sb` 应显示 `main` 与 `origin/main` 同步，没有未提交改动或冲突。

---

### 2. 安装依赖（如有必要）

只有当 `package.json` 或 `package-lock.json` 发生变化时才需要执行：

```bash
npm ci
```

> 推荐用 `npm ci` 而不是 `npm install`，这样可以严格按 `package-lock.json` 复现依赖版本。

如果只有源码改动、依赖没变，可以跳过这一步。

---

### 3. 代码检查

```bash
npm run lint
```

预期结果：无 Error，命令退出码为 0。

---

### 4. 构建生产包

```bash
npx vinext build
```

预期结果：出现 `[5/5] build ssr environment...` 并最终提示 `Build complete.`。

> 注意：在 Windows（Git Bash）环境下，`package.json` 中形如 `WRANGLER_LOG_PATH=... vinext build` 的 npm script 会因为环境变量前缀解析失败。因此建议直接使用 `npx vinext build`。

---

### 5. 运行自动化测试

```bash
node --test tests/rendered-html.test.mjs tests/scoring.test.mjs
```

预期结果：

```text
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

> `npm test` 会先执行 `npm run build` 再运行测试。如果第 4 步已经构建成功，可直接运行 `node --test` 节省时间。

---

### 6. 部署到 Cloudflare

```bash
npx vinext deploy
```

该命令会自动：

1. 重新构建项目（生成 `dist/`）。
2. 使用 Wrangler 上传 Worker 与静态资源。
3. 绑定 D1 数据库和 Images 服务。

部署成功后会输出类似：

```text
Uploaded aggregation-arena (X sec)
Deployed aggregation-arena triggers (X sec)
  https://www.aggrena.com
Current Version ID: a9a90355-c1fb-43ae-91c7-3898dcf14738
```

---

### 7. 验证线上网站

检查首页是否可访问：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://www.aggrena.com/
```

应返回 `200`。

检查 API 是否返回正常数据：

```bash
curl -s "https://www.aggrena.com/api/arena?track=aggregators&window=all&season=all&category=all" | head -c 300
```

应返回包含 `generatedAt`、`stats`、`leaderboard` 等字段的 JSON。

---

## 完整一键脚本

如果你希望把上述步骤合并执行，可以在项目根目录保存以下脚本（例如 `deploy.sh`）：

```bash
#!/usr/bin/env bash
set -e

echo "=== 1. 拉取最新代码 ==="
git pull origin main

echo "=== 2. 检查依赖是否有变化 ==="
# 如果 package-lock.json 相对于上次 npm ci 有更新，可以手动执行 npm ci
# 这里不自动执行，避免不必要的重装

echo "=== 3. 代码检查 ==="
npm run lint

echo "=== 4. 构建生产包 ==="
npx vinext build

echo "=== 5. 运行测试 ==="
node --test tests/rendered-html.test.mjs tests/scoring.test.mjs

echo "=== 6. 部署到 Cloudflare ==="
npx vinext deploy

echo "=== 7. 验证首页 ==="
curl -s -o /dev/null -w "Homepage HTTP: %{http_code}\n" https://www.aggrena.com/

echo "=== 部署完成 ==="
```

Windows PowerShell 用户可使用等效脚本；Windows Git Bash 用户可直接使用上面的 `bash` 脚本。

---

## 常见问题

### `npm run build` 失败，提示不是内部或外部命令

在 Windows Git Bash 下，`package.json` 中的：

```json
"build": "WRANGLER_LOG_PATH=.wrangler/wrangler.log vinext build"
```

会被解析失败。改用：

```bash
npx vinext build
```

### 部署时 Wrangler 提示未登录

运行：

```bash
wrangler login
```

然后重新执行 `npx vinext deploy`。

### 部署成功但网站没变化

1. 检查浏览器是否缓存了旧页面（可强制刷新 `Ctrl + Shift + R` 或打开无痕窗口）。
2. 查看部署输出版本 ID 是否与上次不同。
3. 检查是否推送到了正确的远程分支（`origin/main`），以及本地是否已拉取最新提交。

### 数据库 Schema 有变更

如果 `db/schema.ts` 发生变化，需要先生成 migration：

```bash
npm run db:generate
```

然后检查 `drizzle/` 目录下生成的 migration 文件，确认无误后再提交、部署。

> 注意：D1 生产数据不会随重新部署而丢失。只有执行 migration 或手动重置数据库才会改变数据结构。

---

## 检查清单

每次更新后部署前，确认以下事项：

- [ ] 已拉取最新 `main` 分支
- [ ] 没有未提交的本地改动（`git status` 干净）
- [ ] `npm run lint` 通过
- [ ] `npx vinext build` 成功
- [ ] 测试 `3 pass / 0 fail`
- [ ] `npx vinext deploy` 成功并拿到新的 Version ID
- [ ] 线上首页返回 `200`
- [ ] 线上 `/api/arena` 返回正常 JSON

---

## 相关文件说明

- `wrangler.jsonc`：Cloudflare Worker 配置（入口、兼容性、D1、Images、Assets）。
- `.openai/hosting.json`：Sites/OpenAI 项目元数据（project_id、D1 binding 名称）。
- `vite.config.ts`：Vite 与 Cloudflare 插件配置，本地开发时自动注入占位 D1/R2 binding。
- `package.json`：scripts 与依赖定义。
- `dist/`：生产构建产物，已被 `.gitignore` 忽略，不提交到仓库。
