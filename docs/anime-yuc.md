# 季度新番与公开追番清单

`src/config.ts` 中的 `anime.mode: "yuc"` 使用長門有C的 [yuc.wiki](https://yuc.wiki/) 季度新番表。

## Vercel 在线编辑（站长专用）

打开 `/anime/`，点击「站长登录」并输入管理密码。登录后可在「季度新番」点击「＋ 添加追番」，也可在「我的追番」修改「在看 / 想看 / 看完」或移除作品。每次操作保存成功后立即生效，无需提交代码或重新部署。访客只能查看清单。

页面打开、刷新或切回浏览器窗口时会读取最新清单；已经打开的其他页面不会持续轮询。退出登录会撤销当前会话。登录有效期为 8 小时，过期后重新登录即可。

### 首次配置

1. 在 Vercel 打开 `hxy-blog` 项目，通过 **Storage / Marketplace → Upstash Redis** 创建或连接 Redis 数据库，并连接到项目的 Production 环境。配置流程参见 [Upstash 官方 Vercel 集成指南](https://upstash.com/docs/redis/howto/vercelintegration)。选择适合自己的数据库方案。
2. 在项目 **Settings → Environment Variables** 确认以下服务端变量已经配置：

   | 变量 | 内容 |
   | --- | --- |
   | `UPSTASH_REDIS_REST_URL` | 数据库提供的 HTTPS REST 地址 |
   | `UPSTASH_REDIS_REST_TOKEN` | 数据库提供的可写 REST Token（不能用 Read Only Token） |
   | `ANIME_ADMIN_PASSWORD` | 自己设置的管理密码，至少 16 个字符，建议使用密码管理器生成 |

   兼容 Vercel 集成自动注入的 `KV_REST_API_URL`、`KV_REST_API_TOKEN`，已有这两个变量时不必重复设置 `UPSTASH_*`。若安装时使用了自定义变量前缀，请映射到上述名称。变量必须用于 **Production**；需要预览测试时也为 Preview 配置。不要添加 `PUBLIC_` 前缀，不要把实际密码或 Token 提交进代码。
3. 将本次代码更新推送到 Vercel 关联的仓库并部署；如果仅修改了环境变量，也需要 **Redeploy** 才会生效。继续使用现有 `pnpm build` 和 `dist` 配置即可。
4. 打开 `https://hxy-blog.vercel.app/anime/`，点击「站长登录」，输入设置的密码，即可添加追番。
5. 保存一部作品后，在未登录的浏览器里打开同一网址，应能看到新增作品，但没有添加、修改或移除按钮。退出登录后再次打开页面，清单仍应保留。

### 保存与权限

- `api/anime.js` 是原生 [Vercel Node.js Function](https://vercel.com/docs/functions/runtimes/node-js)，与静态 Astro 网站一起部署，不需要把整个网站改成服务端渲染。
- 清单持久保存在 Redis 中，重新部署不会覆盖。`src/data/anime-watchlist.json` 仅作为数据库尚无清单时的初始数据；第一次在线保存会以这份清单为基础写入 Redis。之后修改本地 JSON 不会覆盖在线清单。
- 线上清单不会自动写回 Git。需要备份时，访问 `/api/anime` 并保存响应里的 `watchlist` 对象，或使用数据库提供的备份功能。
- 默认 Redis key 为 `mizuki:anime:production:watchlist`。Preview 和 Development 分别使用自己的前缀，避免测试修改线上数据。可通过 `ANIME_REDIS_PREFIX` 指定完整前缀；如有设置，务必为不同环境使用不同值。修改前缀或连接另一数据库会切换到另一份清单，原数据仍在原位置。
- 管理密码和数据库凭证仅在服务器使用。浏览器通过 HttpOnly、SameSite Cookie 保存会话；HTTPS 下同时设置 Secure。服务端逐次验证写入权限，并检查同源请求、限制登录尝试次数、使用原子比较保存阻止旧页面覆盖新清单。
- 修改 `ANIME_ADMIN_PASSWORD` 并重新部署后，旧会话失效。当前实现是单站长登录，不提供访客账号或每人独立追番。
- 数据库或密码未配置时，仍能查看已有清单，但不能在线编辑。数据库故障会明确提示读取或保存失败，不会显示“保存成功”。

### 常见问题

- **「在线编辑尚未配置」**：检查 Production 环境变量、密码长度、REST Token 名称，并重新部署。
- **「在线存储暂时不可用」**：检查数据库连接、写入 Token、配额及数据库状态，然后点击「重新读取」。
- **「尝试次数过多」**：同一来源在 15 分钟内连续尝试登录超过 5 次，请等待后再试。
- **「清单有更新」**：页面会尝试读取最新版本；确认清单后重新操作，不会自动覆盖其他页面的保存。
- **`/api/anime` 返回 404**：确认部署包含根目录 `api/anime.js`，且部署到 Vercel；单独上传 `dist` 目录或使用 `pnpm preview` 不会运行这个函数。
- **本地与线上清单不同**：`pnpm dev` 保留原有本地文件编辑模式。验证在线完整流程应使用已配置独立数据库环境的 Vercel Preview 部署。

## 本地编辑

1. 运行 `pnpm dev`，在本机打开 `http://localhost:4321/anime/`（端口以终端输出为准）。
2. 在「季度新番」选择季度、搜索作品并点击「添加追番」。
3. 「我的追番」支持状态修改与移除。每次操作写入 `src/data/anime-watchlist.json`。

本地接口只在 `pnpm dev` 启用，且只接受本机、同源请求。`pnpm preview` 只预览静态页面，不支持本地写入或在线接口。已启用线上 Redis 清单后，请在正式网站登录编辑；本地文件不再是线上清单的唯一数据来源。

## 同步新番

- 本地编辑页点击「同步新番」，或运行 `pnpm update-yuc`，同步北京时间所属季度及下一季度。
- `pnpm build` 会通过 `update-anime` 自动同步。下一季尚未发布或网络失败时保留已有缓存；没有任何有效缓存时构建明确报错。
- 需要其他季度时运行 `pnpm update-yuc --season 202604`，然后随代码部署，新季度会出现在下拉菜单中。
- 抓取结果存放在 `src/data/yuc-catalog.json`，应纳入版本管理，以便无网络时也能预览或构建。抓取只更新番目资料，不会新增或移除追番。
- 线上页面使用本次部署的新番目录，未提供在线抓取按钮；追番选择与状态修改则即时保存。
- 网络需要代理时，使用环境变量 `HTTPS_PROXY` 指定代理。

条目 ID 基于季度和原文标题，不随排序变化。清单保留所选作品的资料快照，旧季度不在当前同步范围内也能展示。不虚构评分、集数或观看进度。

资料来源为長門有C / yuc.wiki，页面保留来源链接和 BY-NC-SA 许可说明；封面沿用源站图片地址，加载失败时显示番名占位。

## 验证

```bash
node --test scripts/tests/*.test.mjs
pnpm check
pnpm exec astro build
```

在线接口测试使用内存 REST 替身，覆盖登录、访客只读、会话退出及过期、跨站拒绝、限流、输入校验、跨实例并发保存、数据持久读取及存储异常；部署后还需按首次配置第 5 步验证真实 Redis 和 Vercel 连接。
