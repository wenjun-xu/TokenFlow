# TokenFlow

本地、只读的 GitHub Copilot CLI Token 用量 Dashboard。按请求日期查看会话、模型用量、
请求明细和数据库已有对话；不上传数据，不估算金额，不读取 `events.jsonl`。

## 安装和使用

**当前为本地实现，尚未公开发布。以下 brew 命令只有在发布源码包和 tap 后才可用。**
计划发布仓库为 `wenjun-xu/TokenFlow`，安装源为 `wenjun-xu/homebrew-tap`：

```bash
brew install wenjun-xu/tap/tokenflow
tokenflow start
tokenflow stop
```

无需预先执行 `brew tap`，也无需手动安装 Python。Homebrew 自动管理 Python 3.13，
在工具自己的无 pip 虚拟环境中安装代码；没有第三方 Python 运行依赖，不使用 PyInstaller。

```bash
tokenflow start --db "/path with spaces/session-store.db"
tokenflow start --no-browser
tokenflow --help
tokenflow --version

# 升级或卸载前先停止后台服务
tokenflow stop
brew upgrade wenjun-xu/tap/tokenflow
# 或 brew uninstall tokenflow
```

默认数据库是 `~/.copilot/session-store.db`。启动后输出带临时访问凭证的浏览器地址；
不要分享该完整地址。关闭终端不停止后台服务，再次启动会复用当前用户的同一实例。
状态和日志仅写入 `~/Library/Application Support/TokenFlow/`，目录 0700、文件 0600。

页面使用服务启动时的 OS 本地时区，修改系统时区后需重启。日期筛选按请求时间而非会话创建时间。
总 Token 为输入加输出，缓存读取单列展示；NULL 显示未知，空请求集合为零。对话固定展示
全会话已记录内容，不推测每轮 Token 或请求归属。长正文按页预览、按需读取。

## 支持边界

- 首发仅 macOS；Python 代码要求 3.11 或以上，formula 固定使用 Homebrew Python 3.13。
- 参考 Copilot 本地 Schema 8，启动时检查实际必需表和字段，不以版本号代替兼容检查。
- SQLite 查询必须运行在已验证的 `/usr/bin/sandbox-exec` 文件写入隔离下。
  该系统接口已弃用：平台缺失或隔离探针失败时拒绝读取，不提供不安全降级。
- 使用活动 WAL 中已提交的数据；如果只读访问需要创建或重建 WAL/SHM，明确报错，
  不创建 sidecar、不忽略 WAL、不修复源库。可检查 Copilot 写入状态后重试。
- 服务仅监听 `127.0.0.1`，使用访问密钥和 Host/Origin 校验。没有 HTTP 停止接口、外部 CDN、
  遥测或自动轮询；不能保证隔离同一 OS 用户的恶意进程。
- 已有本机 Apple Silicon 合成数据检查；Intel、其他 macOS 版本、干净机器安装和真实浏览器
  完整验收仍需在公开发布前完成。不承诺未经验证的平台或性能上限。

## 本地开发

不安装依赖即可从源码运行：

```bash
python3 -B -m tokenflow --version
python3 -B -m tokenflow start --db "/path/to/session-store.db"
python3 -B -m tokenflow stop
python3 -B -m unittest discover -s tests -v
```

测试使用合成 SQLite 数据库，不读取真实 Copilot 数据。运行时隔离和生命周期检查需要 macOS；
前端行为检查使用可选的 Node.js，不是产品运行依赖。也可在开发虚拟环境中 `pip install .`，
此时 pip 会使用 `pyproject.toml` 声明的 setuptools 构建依赖。

## 准备 Homebrew 发布

发布脚本只生成本地文件，不创建仓库、不推送、不上传，也不执行生成的 formula。
确认 GitHub 项目名称后运行；如果仓库不是 `TokenFlow`，用 `--repo` 指定：

```bash
python3 -B scripts/prepare_release.py --owner wenjun-xu --repo TokenFlow
```

输出：

- `dist/tokenflow-0.1.0.tar.gz`：带页面资源的源码归档。
- `dist/tokenflow-0.1.0.tar.gz.sha256`：归档校验值。
- `dist/homebrew-tap/Formula/tokenflow.rb`：引用该版本下载地址和真实 SHA-256 的 formula。

发布步骤：

1. 确认项目许可证、仓库归属和支持的 macOS 范围；当前没有替作者选择开源许可证。
2. 在 `wenjun-xu/TokenFlow` 发布 `v0.1.0`，将生成的归档和校验文件原样上传为 Release assets。
   formula 使用该归档，不使用 GitHub 自动生成的源码压缩包；修改源码后应重新生成所有发布文件。
3. 将生成的 `Formula/tokenflow.rb` 放入公开的 `wenjun-xu/homebrew-tap` 仓库。
4. 在支持的 Apple Silicon 和 Intel macOS 上验收
   `brew install wenjun-xu/tap/tokenflow`、`brew test wenjun-xu/tap/tokenflow`、
   `tokenflow start`、浏览器展示和 `tokenflow stop`。

归档按固定文件清单打包，固定时间戳和文件权限；相同源码重复生成得到相同校验值。
不包含 `.joycode`、本机路径配置、状态、数据库或开发报告。发布本地源码归档不等于已公开发布；
仅生成 formula 也不代表 brew 安装验收已通过。
