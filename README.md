# MyLoopauto

GEO Launch 示例项目。

从一张机会卡生成静态工具页，测试通过后，用指定域名发布到 Cloudflare Pages。Autoloop 确认要上线的域名和 Git 提交，GitHub Actions 执行正式发布并核验线上版本。

## 本地运行

需要 Node.js 24、npm 和 Chromium。仓库里的机会卡是示例，网站在浏览器里生成带 UTM 参数的链接。页面在复制链接成功时发出本地 `geo:conversion` 事件。

```sh
npm ci
npm test
DEPLOY_DOMAIN=preview.example.com npm run build
npx playwright install chromium
DEPLOY_DOMAIN=preview.example.com npm run test:e2e
npm run preview
```

如果机器已经装了 Chromium，可以给 Playwright 设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`，指向浏览器可执行文件。修改 `opportunities/utm-link-builder.json` 可以更换页面标题、说明、证据和事件名。改工具功能时，同时更新 Playwright 验收。

## 连接发布账号

1. 把项目放入站点自己的 GitHub 仓库，默认分支用 `main`。每个生产站点有自己的 Pages 项目、仓库和正式主机名。
2. 在 GitHub Actions 的 `production` 环境设置变量 `CLOUDFLARE_ACCOUNT_ID`、`CF_PAGES_PROJECT`，并配置 Secret `CLOUDFLARE_API_TOKEN`。令牌需要 Cloudflare Pages 编辑及目标区域的 DNS 读取和编辑权限。自动创建新区域时还需要账户的区域创建权限和新区域的相应权限。Pages 项目可以由部署脚本创建。
3. 如果要自动接入 GoDaddy 的新域名，在同一环境配置 `GODADDY_PAT`，使用 GoDaddy Domains v3 的域名读取与名称服务器修改权限。已有活跃 Cloudflare DNS 区域时只需要 Cloudflare 凭据。
4. 如需 Cloudflare 上的 PR 预览，先在 Pages 中连接 GitHub 仓库，设 `main` 为生产分支，关闭 **Enable automatic production branch deployments**，并启用预览分支。生产发布由 Actions 上传。Direct Upload 项目在 CI 中产出 `site-preview`，可在本地查看。

GitHub 的 **Publish to Cloudflare Pages** 工作流可手动运行，必填项只有域名。它重新构建和测试所选的 `main` 提交。生产凭据仅传给发布步骤。使用 Autoloop 时，工作流还会校验你批准的提交 SHA。

## 接入 Autoloop

1. 将 `autoloop/rules.example.json` 的 source、agent 和规则合并进现有配置，换成真实接单机器名和仓库的绝对路径。用 `agent-autoloop check` 检查配置。将规则分配给已配置的桌面或飞书通道。
2. 在接单机器上安装并登录 GitHub CLI，确认它能读取仓库并运行工作流。设置 `GEO_GITHUB_REPO` 为 `owner/repository`。在发起请求的环境另设 `GEO_AUTOLOOP_URL` 和 `GEO_AUTOLOOP_SOURCE_TOKEN`，后者是中台签发给 `geo` 来源的 Token。
3. 在项目目录运行 `node scripts/autoloop.mjs enqueue tools.example.com`。这会为当前 `main` 提交创建上线卡。点「上线」后才发起部署，选择「暂缓」会结束这次请求。脚本会复查 GitHub 结果和正式站点，确认版本后再通知。失败后可在 GitHub 里查看详情、修复并重跑原工作流。

## 域名和验收

- 已接入 Cloudflare 的域名可以直接绑定。对 GoDaddy 域名，脚本先查账户所有权、当前 NS、记录列表及 DNSSEC，再处理识别为空白或停放的区域。若看到现有网站、邮箱、未知记录、DNSSEC 委派或冲突的主机名，会停止并说明原因。迁移这些域名时先确认变更，再人工接入。NS 或证书传播超出等待时间时，后续可以重跑同一版本。
- 上线成功以 Pages 域名状态、正式地址的 HTTPS、`release.json` 中的提交 SHA、主页 canonical、sitemap 和 robots 规则为准。需要另行确认 Cloudflare 的边缘爬虫访问规则，并在真实日志里观察 Googlebot 和 OAI-SearchBot。
- 当前样例验证页面交互、发布与本地事件。找词数据源、真实访问归因、订单或 CRM 接入以及上线后的业务复盘属于后续阶段。

接口参考 [Cloudflare Pages API](https://developers.cloudflare.com/pages/configuration/api/)、[GoDaddy Nameservers API](https://developer.godaddy.com/en/docs/references/rest/domains/v3/update-nameservers)、[Autoloop 协议](https://github.com/KKKKhazix/agent-autoloop/blob/main/docs/protocol.md)。
