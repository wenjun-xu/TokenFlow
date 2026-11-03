# TokenFlow

本地、只读的 GitHub Copilot CLI Token 用量 Dashboard。查看会话、模型用量、
请求明细和已有对话；不上传数据，不估算金额，不读取 `events.jsonl`。

## 安装

```bash
brew install wenjun-xu/tap/tokenflow
tokenflow start
```

无需预先执行 `brew tap`。从 v0.2.0 起，Homebrew 下载当前 Mac 架构对应的
**预编译独立程序**，解压后即可使用：无需安装 Python、Node.js、Bun、npm
或数据库工具，也不在用户机器上编译。运行时和网页资源已经包含在程序内。
v0.2.0 的 Apple Silicon 压缩包约 39 MiB；这是实际下载体积，不代表固定安装耗时。

首次安装仍需获取 Homebrew tap 和程序包。预编译减少安装步骤，但不消除网络限制；
内网必须允许访问 GitHub、其原始文件及 Release 下载地址。项目目前不提供内网镜像。
Homebrew 自动更新等待较久时，可只对本次安装关闭自动更新：

```bash
HOMEBREW_NO_AUTO_UPDATE=1 brew install wenjun-xu/tap/tokenflow
```

这不会跳过文件完整性校验，也不能解决代理超时。不要关闭 TLS 校验。

不使用 Homebrew 时，可在 [Releases](https://github.com/wenjun-xu/TokenFlow/releases)
下载对应架构的 `tokenflow-<版本>-darwin-arm64.tar.gz`（Apple Silicon）或
`tokenflow-<版本>-darwin-x64.tar.gz`（Intel），核对 `SHA256SUMS` 后解压，
执行 `./tokenflow start`。请始终保留这个程序，后台服务及查询子进程需要它。
macOS 如果拒绝打开下载的程序，请核对来源并按系统提示处理，不要关闭 Gatekeeper。

## 使用

```bash
tokenflow start
tokenflow start --db "/path with spaces/session-store.db"
tokenflow start --no-browser
tokenflow stop
tokenflow --help
tokenflow --version
```

默认数据库为 `~/.copilot/session-store.db`。启动后打开浏览器，或在终端输出可手动打开的地址。
该地址含临时访问凭证，不要分享。关闭终端不会停止服务；重复启动复用当前用户的同一实例。
切换数据库前需要停止已有实例。

页面按请求时间和服务启动时的系统本地时区筛选年、月、日，修改系统时区后需重启。
总 Token 为输入加输出，缓存读取单列展示；缺失指标显示未知，空集合显示零。
对话区展示全会话已记录内容，不推测每轮 Token，长正文按页预览、按需展开。
数据通过手动刷新更新，无自动轮询。

升级、卸载或从 v0.1.0 Python 版本迁移前，先停止后台服务：

```bash
tokenflow stop
brew upgrade wenjun-xu/tap/tokenflow
# 或 brew uninstall tokenflow
```

状态及安全诊断仅写入 `~/Library/Application Support/TokenFlow/`，
目录权限 0700、文件权限 0600；不写入 Copilot 数据目录。

## 支持与安全边界

- macOS 14 或以上；提供 Apple Silicon 和 Intel 程序包。Apple Silicon 和 Rosetta 下的
  x64 独立程序已做本机合成数据检查；原生 Intel Mac 及其他 macOS 版本仍待验收。
  x64 隔离查询关闭 JIT，以避免 Rosetta 与文件写入隔离的兼容问题，不放宽只读保护；
  大数据量性能需另行测量。
- v0.2.0 是独立程序迁移预发布；旧 v0.1.0 的源码包和版本标签保留。
- 参考 Copilot Schema 8，按实际必需表和字段检查兼容性。不读取、修复或迁移源库。
- SQLite 查询在 `/usr/bin/sandbox-exec` 禁止文件写入的隔离子进程中执行。
  接口已被系统弃用；不可用或隔离探针失败时明确拒绝读取，不提供不安全降级。
- 不忽略活动 WAL，不创建或重建源库 WAL/SHM；只读访问无法完成时明确报错。
- HTTP 仅监听 `127.0.0.1`，校验访问密钥、Host、Origin 和跨站请求。
  无 HTTP 停止接口、外部 CDN 或遥测；不保证隔离同一 OS 用户的恶意程序。
- 不承诺未经实测的安装速度、其他 macOS 兼容性或数据规模上限。
- 源码公开，许可证尚未确定；请勿把公开仓库等同于已授予任意使用或再分发许可。

## 本地开发

开发和构建需要 Bun 1.4.4。只有开发者安装工具和类型检查依赖，用户无需安装：

```bash
bun install --frozen-lockfile
bun run typecheck
bun test tests-ts tests-release
bun src/cli.ts start --db "/path/to/synthetic.db"
bun src/cli.ts stop
```

测试仅使用合成数据库和独立状态目录，不读取真实 Copilot 会话。
运行隔离、原生程序和后台生命周期检查需要 macOS。

## 发布

在 macOS 上从待发布的源码提交构建：

```bash
bun scripts/prepare_release.ts
# 可指定已经下载且版本匹配的官方 Intel Bun 程序，避免构建时再次下载：
bun scripts/prepare_release.ts dist "/path/to/intel/bun"
# 解压后，对实际发布程序验收（只读合成数据库，使用独立 HOME）：
bun scripts/verify_native.ts "/path/to/extracted/tokenflow"
```

脚本生成两种架构的单程序归档、`SHA256SUMS`、大小记录和
`dist/homebrew-tap/Formula/tokenflow.rb`，不自动上传：

1. 运行类型检查、合成数据测试和独立程序验收；在支持的平台检查签名、启动、筛选及停止。
2. 将源码提交到 `wenjun-xu/TokenFlow`，在新版本 Release 上传两份程序包和校验文件。
   标签绑定实际源码提交，不覆盖已发布版本。
3. 更新 `wenjun-xu/homebrew-tap` 的 formula，使下载地址和 SHA-256 精确匹配上传的程序包。
4. 验收 `brew install wenjun-xu/tap/tokenflow` 和 `brew test wenjun-xu/tap/tokenflow`。

归档只包含 `tokenflow` 程序。不要上传 Token、数据库、状态、日志、`.publish`、
`.joycode`、开发依赖或个人配置；GitHub 自动生成的源码包不是用户安装程序包。
