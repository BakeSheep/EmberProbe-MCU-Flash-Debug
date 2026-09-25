# EmberProbe 发布指南

推送稳定版本标签后，[Release 工作流](../.github/workflows/release.yml)会验证版本、运行质量门禁、生成 VSIX，并自动创建 GitHub Release 和上传附件。

## 权限与安全

Windows J-Link 驱动功能在本版随未签名的 helper 与 libwdi DLL 发布。Release 工作流在一次性 Windows runner 上构建它们，生成 SHA-256 清单，并验证构建产物与 VSIX 内字节一致；helper 在提权后还会核对配套 DLL 的 SHA-256。哈希校验不能提供发布者身份认证，Windows 可能显示“未知发布者”或根据本机策略阻止运行。发布 job 只在发布阶段申请 `contents: write`，并使用 GitHub 自动提供的短期 `GITHUB_TOKEN` 创建 Release。建议保护 `v*` 标签，防止未审查的提交触发发布。

## 发布稳定版本

以下示例发布 `0.5.0`：

```powershell
npm run release:prepare -- 0.5.0 --date 2026-07-31
npm run check
npm run quality
git add package.json package-lock.json README.md README_EN.md CHANGELOG.md
git commit -m "chore: prepare v0.5.0"
git tag -a v0.5.0 -m "EmberProbe v0.5.0"
git push origin master
git push origin v0.5.0
```

标签必须严格使用 `vX.Y.Z`，并与 `package.json`、lock 文件、README 和 Changelog 一致。预发布标签（例如 `v0.5.0-beta.1`）会被拒绝，避免意外覆盖稳定渠道。

工作流依次执行：

1. 复用 CI：Windows、Ubuntu、macOS 的 Node 20 普通检查和 bundle、Windows libwdi/helper 原生构建、Ubuntu Node 24 质量检查及 Extension Host 冒烟测试。
2. 在 Windows 构建 libwdi 与 helper，验证 WDK 二进制的 Microsoft 签名，将 libwdi 的 SHA-256 编入 helper，并生成两个未签名原生文件的 SHA-256 清单。
3. 校验标签与发布元数据，将原生文件下载到打包任务，核对 SHA-256，生成 VSIX 并核对包内字节与清单一致。
4. 创建 GitHub Draft Release 并上传已验证的 VSIX；附件上传成功后转为正式 Release。

## 失败与重试

如果创建 Release、上传附件或公开草稿失败，在 GitHub **Actions → Release → Run workflow** 中输入原标签重跑。

工作流可安全处理常见重试场景：

- Draft Release 已存在时会复用并更新 VSIX。
- GitHub Release 已经公开时会直接结束，不重复发布。

不要删除已经发布的标签后用同一版本指向其他提交；发布构件应保持不可变。
