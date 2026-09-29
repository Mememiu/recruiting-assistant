# BOSS CLI 职位管理适配补丁

`job-v2-positions.patch` 适用于本项目使用的 `boss-engine-local` 0.8.1。BOSS 职位管理改版后，旧版 CLI 无法识别职位卡片，导致 `boss positions` 返回空列表，`boss jd <职位名>` 也无法读取详情。

补丁让 CLI 从新版 `job_v2/list` 页面读取职位，按“全部”分页获取完整列表，并在打开、退出职位详情时校验页面状态。它不包含本地职位、候选人数据、登录态或服务配置。补丁只修改引擎中的 `dist/toolset/jd.js`；不会自行安装或修改现有引擎。

在对应版本的引擎包根目录，先检查版本和原文件 SHA-256（应为 `3e28b24589e62d4c236ab91f571f8d16fd58986d6cad5c70cf2a5c7bf4cfe55a`），再运行：

```sh
patch --dry-run -p1 < /path/to/recruiting-assistant/patches/boss-cli/job-v2-positions.patch
patch -p1 < /path/to/recruiting-assistant/patches/boss-cli/job-v2-positions.patch
```

补丁后的 `dist/toolset/jd.js` SHA-256 应为 `7499b204d400bb710e8d09c252d74e99e7478effc6fd809e45283f5c2966df5a`。不同版本或文件校验值不符时，不直接套用补丁。验证命令为 `boss positions` 和 `boss jd <职位名>`；后者也应能读取位于第二页的职位并正常返回列表。

该补丁基于 GPL-3.0 授权的 BOSS CLI 衍生版本，许可文本见 [LICENSE](LICENSE)。
