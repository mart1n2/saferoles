# SafeRoles 数据与部署方案

更新：2026-10-27。用户已授权并实施静态迁移；未发布，也未迁移或删除既有生产 D1 数据。

## 当前选择

React + Vite 输出纯静态 `dist/`。浏览器通过 SDK、RPC 和公共 API 读取数据。
IndexedDB 保存草稿、ABI、本机提交记录与加密凭证；没有应用后端、登录或云数据库。

| 数据 | 来源 |
| --- | --- |
| 完整 Roles 角色、成员、条件树、allowance 列表 | 公共 Zodiac 索引器，浏览器直连并校验结构 |
| Safe 控制关系、模块启用、初始化结果 | Safe host / 选定钱包的 RPC |
| 待签名提案、签名数量、执行状态 | Safe Apps SDK；独立页面可用用户 Safe API key 查询服务 |
| ABI | Sourcify；可选用户 Etherscan key；手动导入 |
| 未提交草稿、名称、标签 | IndexedDB + JSON 导入导出 |

“静态”意味着不运行自己的应用服务，不意味着网站不发网络请求。完整权限枚举仍依赖索引器。
链下待签名信息不存在于普通 RPC 结果里；safeTxHash 也不是普通执行交易哈希。
外层 receipt 成功与 Safe 内部调用成功要分开识别。

## 数据库

当前需求无需 D1、Postgres、RDS。只有明确要跨设备同步、组织共享草稿、云端审计留存、
网页关闭后监控或通知时，再添加数据库和后端。

本地存储不提供跨设备同步。浏览器清理、origin 更换或 iframe 存储分区可能影响记录。
草稿导出排除所有 API key。导入验证大小、版本和 scope，并创建新记录。
保存时在单个 IndexedDB 事务中比较版本，避免两个标签页静默覆盖。
浏览器存储行为见 [MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
及[配额与回收](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)。

旧 D1 没有自动同步到本地。若已有重要线上记录，另行从旧系统导出，验证归属与结构后迁入；
本次源码迁移不等于生产数据迁移。后续迁移托管时也不再依赖 Sites 身份请求头。

## 私密 API

用户输入 API key，默认仅内存使用。选择保存时，Web Crypto 用口令派生密钥，
AES-256-GCM 加密后存 IndexedDB。口令与派生密钥不保存；下次打开需解锁。
支持锁定、替换和删除。密文认证绑定服务身份，不能将 Safe 密文换成 Etherscan 使用。
依据为 Web Crypto 的 [deriveKey](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey) 能力。

这解决保存需求，不会绕过 API 的浏览器 CORS 或服务条款。解锁后页面脚本能访问 key，
因此仍需保护发布链路。key 只发往固定服务域名，不经本应用服务器，不自动转发重定向。
若服务拒绝跨域，则显示不可用，使用 Safe UI 或手动 ABI，不静默增加代理后端。

## 平台比较

| 方案 | 运行内容 | 工作量 | 建议 |
| --- | --- | --- | --- |
| Cloudflare Pages | 同一份 `dist/` | Git 构建、域名；`_headers` 已提供 | 无平台偏好时优先 |
| Vercel | 同一份 `dist/` | Git 构建、域名；`vercel.json` 已提供 | 同样适合，无需自建服务器 |
| AWS Amplify Hosting | 同一份 `dist/` | Git/构建与响应头配置 | 公司统一 AWS 时优先考虑 |
| AWS S3 + CloudFront | 同一份 `dist/` | 私有 S3 REST origin、OAC、CDN、HTTPS、缓存与响应头 | 适合已有 IaC/CDN 规范的团队 |
| AWS 容器 + RDS | Node 后端与数据库 | 发布、连接管理、备份和认证 | 当前没有必要 |

Vercel 官方支持 [Vite 静态部署](https://vercel.com/docs/frameworks/frontend/vite)。
AWS 官方提供 [S3 与 Amplify 静态托管](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html)。
Vercel、Cloudflare 和 Amplify 都是托管；区别在于不需要自己管理常驻应用服务器。
即使选 AWS，也不因此需要 EC2 或 RDS。不报未经流量测量的月费。

## 发布配置

构建 `npm ci && npm run build`，发布 `dist/`，不配置数据库绑定或服务端密钥。

- Safe manifest 需 HTTPS、公开访问和 `Access-Control-Allow-Origin: *`。
- 允许 Safe iframe 嵌入，不能用 `X-Frame-Options: DENY/SAMEORIGIN` 阻断；提供的 CSP 明确列出 Safe 域名。
- HTML 短缓存，hash 资源长缓存。保留上一版本资源以兼容已打开的页面。
- 静态环境变量都会公开，不能塞入操作者共享密钥。
- Cloudflare Pages 读取 `_headers`，Vercel 读取 `vercel.json`；AWS 须手动配置对应响应头。
- 使用稳定域名；换域名之前导出本机工作区。

## 验收边界

本地自动验证覆盖：输入/scope 校验、版本冲突、导入导出、密文篡改、错误口令、锁定与删除，
以及权限 planner、初始化、钱包 provider 身份和静态产物。

生产发布前还需在真实托管域名验证 manifest/CSP/CORS、Safe iframe 存储行为、
真实钱包与服务 API key。没有这些实测，不能把“构建通过”写成“真实 Safe 操作验收通过”。
不签名、不广播交易作为常规自动测试。
